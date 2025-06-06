import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({
  path: path.resolve(__dirname, '../../.env')
});

interface ServerConfig {
  name: string;
  port: number;
  path: string;
  env_prefix: string;
}

export type ServerConfigs = Record<string, ServerConfig>;

let serverConfigs: ServerConfigs | null = null;

export function getEnvConfig(serverType: string): Record<string, string> {

  const envConfig = {
    MCP_TRANSPORT_TYPE:  process.env.MCP_TRANSPORT_TYPE || 'sse',
    MCP_SSE_PORT:  process.env.MCP_SSE_PORT || '44330',
    MCP_SSE_HOST: process.env.MCP_SSE_HOST || '0.0.0.0',
    MCP_SSE_PATH: process.env.MCP_SSE_PATH || '/mcp',
    MCP_SSE_CORS_ORIGIN:  process.env.MCP_SSE_CORS_ORIGIN || '*',
    MCP_STDIO_CLIENTID:  process.env.MCP_STDIO_CLIENTID || '',
    MCP_STDIO_TENANTID:  process.env.MCP_STDIO_TENANTID || '',
    MCP_STDIO_CLIENTSECRET:  process.env.MCP_STDIO_CLIENTSECRET || '',
  };

  logger.info('Environment config:', { serverType, config: envConfig });
  return envConfig;
}