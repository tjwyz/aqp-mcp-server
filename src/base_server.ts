#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { TransportConfig, getServerConfig } from './utils/transport_config.js';
import { TransportFactory } from './utils/transport_factory.js';
import { TransportManager } from './utils/transport_manager.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { logger, EventType } from './utils/logger.js';
import { fetchParams } from './utils/aqp.js';
import { getToken } from './utils/token.js';

import * as fs from 'node:fs';
import * as path from 'node:path';

export abstract class BaseServer {
  protected server: Server;
  protected name: string;
  protected version: string;
  protected tools: Record<string, any>;
  protected serverName: string;
  protected additionalDimensions: Record<string, any>;
  protected config: TransportConfig;
  protected transportManager: TransportManager;

  constructor(
    name: string,
    tools: Record<string, any>,
    serverType: string,
    config?: TransportConfig,
  ) {
    this.name = name;
    this.tools = tools;
    this.serverName = name;
    this.version = this.loadPackageVersion() || '0.1.5';
    this.additionalDimensions = {};
    this.config = config || getServerConfig(serverType);
    this.transportManager = new TransportManager();

    this.server = new Server(
      {
        name: this.name,
        version: this.version,
      },
      {
        capabilities: {
          tools: this.tools,
        },
      },
    );

    // Error handling
    this.server.onerror = (error) => {
      logger.error('[MCP Error]', error);
      logger.event(EventType.SERVER_ERROR, {
        serverName: this.serverName,
        version: this.version,
        error: error.toString(),
      });
    };

    process.on('SIGINT', async () => {
      logger.info('Shutting down server...');
      logger.event(EventType.SERVER_SHUTDOWN, {
        serverName: this.serverName,
        version: this.version,
      });
      await this.server.close();
      logger.close();
      process.exit(0);
    });
  }

  protected setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: Object.values(this.tools),
    }));
    logger.info('Tools registered:', Object.keys(this.tools));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args, sessionId } = request.params;

      // Add timing and event logging
      const startTime = Date.now();
      let status = 'success';
      let result;

      try {
        result = await this.handleToolCall(name, args, this.config, sessionId as string);
      } catch (error) {
        status = 'failure';
        throw error;
      } finally {
        const endTime = Date.now();
        const duration = endTime - startTime;

        // Log the event with all dimensions
        logger.event(EventType.TOOL_INVOKED, {
          name,
          duration,
          status,
          args: JSON.stringify(args),
          serverName: this.serverName,
          version: this.version,
          ...this.additionalDimensions,
        });
      }

      return result;
    });
  }

  protected abstract handleToolCall(
    name: string,
    args: any,
    config: TransportConfig,
    sessionId: string,
  ): Promise<any>;

  protected abstract initializeHandlers(): Promise<void>;

  public async run() {
    logger.info(`Starting ${this.name} server initialization...`);
    logger.event(EventType.SERVER_STARTED, {
      serverName: this.serverName,
      version: this.version,
      toolCount: Object.keys(this.tools).length,
      transportType: this.config.type,
    });

    const startTime = Date.now();

    try {
      // Initialize all handlers before connecting
      logger.info('Initializing handlers...');
      await this.initializeHandlers();
      logger.info('Handlers initialized successfully');

      logger.info('Setting up transport with config:', this.config);

      if (this.config.type === 'sse') {
        if (!this.config.sseConfig) {
          throw new Error('SSE configuration is required when using SSE transport');
        }

        // Set up Oauth server
        const express = TransportFactory.getSingletonExpressApp();
        TransportFactory.setupAuthOnlyServer(express, this.config.sseConfig);
        // fetch token
        const token = await getToken(this.config);
        if (!token) {
          throw 'token 获取失败';
        }
        await fetchParams({ token });

        // Set up SSE server
        logger.info('Setting up SSE server...');
        TransportFactory.setupExpressServer(
          express,
          this.server,
          this.config.sseConfig,
          this.transportManager,
        );

        logger.event(EventType.SERVER_CONNECTED, {
          serverName: this.serverName,
          version: this.version,
          totalStartupTime: Date.now() - startTime,
          transportType: 'sse',
        });

        logger.info(`${this.name} MCP server running on SSE (port ${this.config.sseConfig.port})`);
      } else {
        // Use stdio transport
        logger.info('Creating stdio transport...');
        const transport = TransportFactory.createStdioTransport();

        const token = await getToken(this.config);
        if (!token) {
          throw 'token 获取失败';
        }
        await fetchParams({ token });

        // Connect to transport
        logger.info('Connecting to transport...');
        await this.server.connect(transport);

        logger.event(EventType.SERVER_CONNECTED, {
          serverName: this.serverName,
          version: this.version,
          totalStartupTime: Date.now() - startTime,
          transportType: 'stdio',
        });

        logger.info(`${this.name} MCP server running on stdio`);
      }
    } catch (error) {
      logger.error(`Failed to start ${this.name} server:`, error);

      logger.event(EventType.SERVER_ERROR, {
        serverName: this.serverName,
        version: this.version,
        error: error instanceof Error ? error.message : String(error),
        phase: 'startup',
        transportType: this.config.type,
      });

      throw error;
    }
  }

  private loadPackageVersion(): string | undefined {
    try {
      // Try multiple strategies to find the package.json

      // Strategy 1: Using import.meta.url (ES modules approach)
      let packageJsonPath: string | null = null;
      try {
        const currentFileUrl = import.meta.url;
        const currentPathname = new URL(currentFileUrl).pathname;

        // Fix Windows paths by removing leading slash from pathname
        const currentFilePath =
          process.platform === 'win32'
            ? currentPathname.substring(1) // Remove leading slash on Windows
            : currentPathname;

        const dirPath = path.dirname(currentFilePath);

        // Navigate up from the current directory to find the package.json
        packageJsonPath = path.resolve(dirPath, '..', 'package.json');
        logger.info(`Strategy 1 - Looking for package.json at: ${packageJsonPath}`);

        if (fs.existsSync(packageJsonPath)) {
          const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
          logger.info(`Found package.json with version: ${packageJson.version}`);
          return packageJson.version || undefined;
        }
      } catch (e) {
        logger.warn(`Strategy 1 failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return undefined;
    } catch (error) {
      logger.error('Failed to load package version:', error);
      return undefined;
    }
  }
}
