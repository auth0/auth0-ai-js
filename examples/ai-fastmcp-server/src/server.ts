import { loadAppConfig } from "./config.js";
import { createApp } from "./app.js";

const config = loadAppConfig();
const server = createApp(config);
await server.start({
  transportType: "httpStream",
  httpStream: { port: config.port, stateless: true },
});
console.log(`MCP server listening on port ${config.port}`);
