import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { getEnvConfig } from './server_config.js';
import { logger } from './logger.js';

// Transport configuration interfaces
export interface SSEConfig {
  port: number;
  host?: string;
  path?: string;
  cors?: {
    origin: string | string[];
    methods: string[];
  };
}

export interface STDIOConfig {
  clientId: string;
  tenantId: string;
  clientSecret: string;
}

export interface TransportConfig {
  type: 'stdio' | 'sse';
  sseConfig?: SSEConfig;
  stdioConfig?: STDIOConfig;
}

// Get configuration for a specific server
export function getServerConfig(serverType: string): TransportConfig {
  const envConfig = getEnvConfig(serverType);

  const config: TransportConfig = {
    type: envConfig.MCP_TRANSPORT_TYPE === 'sse' ? 'sse' : 'stdio',
  };

  if (config.type === 'sse') {
    config.sseConfig = {
      port: parseInt(envConfig.MCP_SSE_PORT, 10),
      host: envConfig.MCP_SSE_HOST,
      path: envConfig.MCP_SSE_PATH,
      cors: {
        origin: envConfig.MCP_SSE_CORS_ORIGIN,
        methods: ['GET', 'POST']
      }
    };
    logger.info('SSE transport configuration:', {
      serverType,
      config: config.sseConfig
    });
  } else {
    config.stdioConfig = {
      clientId: envConfig.MCP_STDIO_CLIENTID,
      tenantId: envConfig.MCP_STDIO_TENANTID,
      clientSecret: envConfig.MCP_STDIO_CLIENTSECRET
    };
    logger.info('STDIO transport configuration:', {
      serverType
    });
  }

  return config;
}

// Default configuration (for backward compatibility)
// export const DEFAULT_CONFIG: TransportConfig = getServerConfig('ado_tools_server');
logger.info('Default transport configuration loaded for ado_tools_server');