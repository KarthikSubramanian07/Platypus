/**
 * `pnpm dial:register-mcp [--dry-run]`: registers the Context MCP with Dial, replacing
 * any earlier connection named "platypus". Needs DIAL_API_KEY, PUBLIC_BASE_URL,
 * CONTEXT_MCP_SECRET and CONTEXT_MCP_TOKEN. Registers a URL only: it places no call
 * and sends no message. Credentials are always printed masked.
 */
import { existsSync } from "node:fs";
import { runRegisterCli } from "../src/context-mcp/dial-registry";

if (existsSync(".env")) process.loadEnvFile(".env");
process.exitCode = await runRegisterCli(process.argv.slice(2), {
  env: process.env,
  fetch: (url, init) => fetch(url, init),
  out: (line) => console.log(line),
});
