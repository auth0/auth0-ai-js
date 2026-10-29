import { FastMCP } from "fastmcp";
import type { Logger } from "fastmcp";
import type { Auth0Session } from "@auth0/ai-fastmcp";
import { createAuth } from "./auth.js";
import type { AppConfig } from "./config.js";
import { registerTools } from "./tools.js";

/**
 * Builds the MCP server: FastMCP with the Auth0 options spread in, and the tools. Start it with
 * `server.start({ transportType: "httpStream", httpStream: { port, stateless: true } })`.
 */
export function createApp(config: AppConfig, options: { logger?: Logger } = {}): FastMCP<Auth0Session> {
  const server = new FastMCP<Auth0Session>({
    name: "orders-example",
    version: "0.1.0",
    ...createAuth(config),
    ...(options.logger !== undefined && { logger: options.logger }),
  });
  registerTools(server, config);
  return server;
}
