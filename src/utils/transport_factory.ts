import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
import cors from 'cors';
import { logger } from './logger.js';
import { SSEConfig } from './transport_config.js';
import { TransportManager } from './transport_manager.js';
import { tokenWaiters } from './token.js';

// Using any type to avoid TypeScript errors when working with Express types
type AnyRequest = any;
type AnyResponse = any;

let appInstance: express.Express | null = null;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Factory for creating the appropriate transport
export class TransportFactory {
  // Create a transport based on configuration
  static createStdioTransport(): StdioServerTransport {
    logger.info('[Transport] Creating stdio transport');
    return new StdioServerTransport();
  }

  static getSingletonExpressApp(): express.Express {
    if (!appInstance) {
      appInstance = express();
    }
    return appInstance;
  }

  static setupAuthOnlyServer(app: express.Express, config: SSEConfig): void {
    // Configure CORS
    app.use(
      cors({
        origin: config.cors?.origin || '*',
        methods: config.cors?.methods || ['GET', 'POST'],
      }),
    );

    const pathBase = config.path || '/mcp';
    logger.info('[SSE] Setting up server', {
      path: pathBase,
      cors: config.cors,
    });

    app.get('/oauthcallback', (req, res) => {
      const code = req.query.code as string;

      if (!code) {
        res.status(400).send('❌ Missing ?code from redirect URL');
        return;
      }

      const cb = tokenWaiters.shift(); // ⚠️ 保证顺序匹配
      if (!cb) {
        res.status(500).send('❌ No pending token waiter to handle this code');
        return;
      }

      cb(code); // ✅ 触发 getUserToken() 内部的闭包
      res.send(`<h2>✅ Login complete. You can close this tab.</h2>`);
    });

    // Start the server
    const host = config.host || 'localhost';
    const httpServer = config.host
      ? app.listen(config.port, config.host, () => {
          logger.info('[SSE] Server started', {
            host,
            port: config.port,
            path: pathBase,
          });
        })
      : app.listen(config.port, () => {
          logger.info('[SSE] Server started', {
            host,
            port: config.port,
            path: pathBase,
          });
        });

    // Handle server shutdown
    process.on('SIGINT', () => {
      logger.info('[SSE] Shutting down server');
      httpServer.close();
    });
  }

  // Configure Express server for SSE
  static setupExpressServer(
    app: express.Express,
    server: Server,
    config: SSEConfig,
    transportManager: TransportManager,
  ): void {
    const pathBase = config.path || '/mcp';
    // Set up health endpoint for k8s probes
    app.get('/health', (req: AnyRequest, res: AnyResponse) => {
      res.status(200).send('OK');
    });

    // Set up the SSE endpoint
    app.get(pathBase, (req: AnyRequest, res: AnyResponse) => {
      const transport = new SSEServerTransport(pathBase, res as any);

      // Register the transport
      transportManager.registerTransportSession(transport);

      // Connect to the MCP server
      server.connect(transport).catch((error) => {
        logger.error('[SSE] Connection failed:', error);
      });
    });

    // Set up the POST endpoint to receive messages
    app.post(pathBase, async (req: AnyRequest, res: AnyResponse) => {
      const sessionId = req.query.sessionId as string;
      if (!sessionId) {
        logger.warn('[SSE] Missing sessionId parameter');
        res.status(400).send('Missing sessionId parameter');
        return;
      }

      const transport = transportManager.getTransportForSession(sessionId);
      if (!transport) {
        logger.warn('[SSE] Session not found:', { sessionId });
        res.status(404).send(`Session not found: ${sessionId}`);
        return;
      }

      try {
        await transport.handlePostMessage(req as any, res as any);
      } catch (error) {
        logger.error('[SSE] Failed to handle message:', {
          sessionId,
          error,
        });
        if (!res.headersSent) {
          res.status(500).send('Internal server error');
        }
      }
    });

    app.get('/json', (req, res) => {
      res.sendFile(path.join(__dirname, '../../template/render.html'));
    });

    // 动态数据 API
    app.get('/api/data', async (req: AnyRequest, res: AnyResponse) => {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Missing id' });

      const fileName = `aqp-result-${id}.json`;

      const filePath = path.join(__dirname, '../../aqp-data/', fileName);

      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const json = JSON.parse(content);
        res.json(json);
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          res.status(404).json({ error: `File not found: ${fileName}` });
        } else {
          res.status(500).json({ error: 'Failed to read file', detail: err.message });
        }
      }
    });
  }
}
