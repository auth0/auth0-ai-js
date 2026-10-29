// Public entry point of @auth0/ai-fastmcp: Auth0 authentication for FastMCP servers.
export { createFastMcpAuth } from "./create.js";
export type { FastMcpAuth } from "./create.js";
export type { FastMcpAuthOptions, FastMcpAuthBaseOptions } from "./options.js";
export type { FastMcpOAuthOptions, FastMcpProtectedResource } from "./metadata.js";
export type { SessionBindingOptions } from "./binding.js";
export type { Auth0Session } from "./session.js";
export { withAuth0Execute } from "./tool.js";
export type { ToolErrorResult, WithAuth0ExecuteOptions } from "./tool.js";
