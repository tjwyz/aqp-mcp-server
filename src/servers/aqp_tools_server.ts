#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BaseServer } from "../base_server.js";
import { AQPHandler } from "../handlers/aqp_handler.js";
import { TransportConfig } from "../utils/transport_config.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const aqpTools = require("../schemas/aqp_tools.json");

export class AQPToolsServer extends BaseServer {
  private aqpHandler: AQPHandler;

  constructor() {
    super("aqp-tools", aqpTools, "aqp_tools_server");
    this.aqpHandler = new AQPHandler();
  }

  protected async initializeHandlers(): Promise<void> {
    this.setupToolHandlers();
    console.log("AQP tools handlers initialized successfully");
  }

  protected async handleToolCall(name: string, args: any, config: TransportConfig) {
    switch (name) {
      case "wiki_search": {
        if (!args || typeof args.query !== "string") {
          throw new McpError(ErrorCode.InvalidParams, "Invalid or missing 'query' parameter");
        }
        return await this.aqpHandler.handleQueryAQP(args);
      }
      case "generate_aqp_search_prompt": {
        if (!args || typeof args.userInput !== "string") {
          throw new McpError(ErrorCode.InvalidParams, "Invalid or missing 'userInput' parameter");
        }
        return await this.aqpHandler.generateAqpSearchPrompt(args);
      }
      case "aqp_search": {
        if (
          !args ||
          typeof args.query !== "string" ||
          typeof args.model !== "string"
        ) {
          throw new McpError(ErrorCode.InvalidParams, "Missing required 'model' or 'query' parameter");
        }

        if (args.params && !Array.isArray(args.params)) {
          throw new McpError(ErrorCode.InvalidParams, "'params' must be an array if provided");
        }

        return await this.aqpHandler.aqpSearch(args, config);
      }
      default:
        throw new McpError(ErrorCode.InvalidParams, `Unknown tool name: ${name}`);
    }
  }
}

const currentFile = fs.realpathSync(path.resolve(fileURLToPath(import.meta.url)));
const invokedFile = fs.realpathSync(path.resolve(process.argv[1] ?? ''));
// Create and run server instance if this is the main module
if (process.argv[1] && currentFile === invokedFile) {
  const serverInstance = new AQPToolsServer();
  serverInstance.run().catch(console.error);
}