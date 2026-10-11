import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { GatewayTools } from "@platypus/shared/contracts";
import { createMcpServer } from "./mcp";

/**
 * The gateway over stdio, for tests and local poking. Not for the demo: a second process
 * writes its own events, and `pnpm dev` already serves /mcp over HTTP.
 */
export async function runStdio(tools: GatewayTools): Promise<void> {
  await createMcpServer(tools).connect(new StdioServerTransport());
}
