/**
 * `pnpm dial:mcp-status`: prints the "platypus" Context MCP as Dial sees it (status,
 * authMode, toolCount, lastError), with credentials masked. Read-only.
 */
import { existsSync } from "node:fs";
import { runStatusCli } from "../src/context-mcp/dial-registry";

if (existsSync(".env")) process.loadEnvFile(".env");
process.exitCode = await runStatusCli(process.argv.slice(2), {
  env: process.env,
  fetch: (url, init) => fetch(url, init),
  out: (line) => console.log(line),
});
