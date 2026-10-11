/**
 * The Context MCP: VoiceTools served to Dial's voice agent mid-call over
 * stateless streamable HTTP at /mcp/<CONTEXT_MCP_SECRET>, behind a static bearer
 * token (CONTEXT_MCP_TOKEN).
 *
 * Wiring in packages/voice/src/index.ts mount():
 *
 *   const { secret, token } = resolveContextMcpCredentials();
 *   const tools = createVoiceTools({ db, bus, textChannel: loadConfig().textChannel });
 *   app.route("/", createContextMcpRoutes({ tools, secret, token, allowedHosts: contextMcpAllowedHosts(process.env.PUBLIC_BASE_URL) }));
 *
 * OAuth path (documented, not used): Dial also supports authMode "oauth" with
 * Dynamic Client Registration. That would mean answering 401 with WWW-Authenticate,
 * serving /.well-known/oauth-protected-resource (buildOAuthProtectedResourceMetadata),
 * and verifying tokens with requireBearerAuth from @modelcontextprotocol/server.
 * The static bearer plus the unguessable path is enough for a single Dial account.
 */
export { readDialContext } from "./dial-context";
export { spokenError, describeResult } from "./spoken";
export { buildContextMcpServer, createContextMcpHandler, type ContextMcpServerOptions, type ToolCallLog } from "./server";
export { createContextMcpRoutes, contextMcpAllowedHosts, contextMcpUrl, type ContextMcpRoutesOptions } from "./routes";
export {
  generateContextMcpSecret,
  generateContextMcpToken,
  resolveContextMcpCredentials,
  maskSecret,
  secretProblem,
  MIN_SECRET_BYTES,
  MIN_TOKEN_BYTES,
  type ContextMcpCredentials,
} from "./secret";
export {
  CONTEXT_MCP_NAME,
  DIAL_API_BASE,
  planRegistration,
  registerContextMcp,
  listContextMcps,
  runRegisterCli,
  runStatusCli,
  type DialContextMcp,
} from "./dial-registry";
export { createVoiceTools, type VoiceToolsDeps } from "../tools/voice-tools";
