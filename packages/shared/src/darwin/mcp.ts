import { DARWIN_MCP_URL } from "./client";

/** The Darwin MCP tools customer agents rely on to find and work with Platypus routes. */
export const REQUIRED_MCP_TOOLS = ["search", "act", "get_thread"] as const;

export interface McpProbe {
  ok: boolean;
  serverVersion: string | null;
  protocolVersion: string | null;
  tools: string[];
  missingTools: string[];
  error: string | null;
}

/**
 * Anonymous initialize + tools/list against Darwin's remote MCP server, the same
 * handshake Claude, Muse or Cursor performs. Search and tool discovery need no sign-in.
 */
export async function probeDarwinMcp(
  options: { url?: string; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<McpProbe> {
  const url = options.url ?? DARWIN_MCP_URL;
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const rpc = async (id: number, method: string, params: unknown, protocolVersion?: string) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`);
    const message = parseRpcBody(await response.text(), id);
    if (message.error) throw new Error(`${method} failed: ${JSON.stringify(message.error).slice(0, 200)}`);
    return message.result as Record<string, unknown>;
  };

  try {
    const init = await rpc(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "platypus-doctor", version: "0.1.0" },
    });
    const protocolVersion = typeof init.protocolVersion === "string" ? init.protocolVersion : null;
    const serverInfo = (init.serverInfo ?? {}) as { version?: unknown };
    const list = await rpc(2, "tools/list", {}, protocolVersion ?? undefined);
    const tools = Array.isArray(list.tools) ? list.tools.map((t) => String((t as { name?: unknown }).name)) : [];
    const missingTools = REQUIRED_MCP_TOOLS.filter((t) => !tools.includes(t));
    return {
      ok: missingTools.length === 0,
      serverVersion: typeof serverInfo.version === "string" ? serverInfo.version : null,
      protocolVersion,
      tools,
      missingTools,
      error: missingTools.length ? `missing tools: ${missingTools.join(", ")}` : null,
    };
  } catch (error) {
    return {
      ok: false,
      serverVersion: null,
      protocolVersion: null,
      tools: [],
      missingTools: [...REQUIRED_MCP_TOOLS],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Streamable HTTP answers with either plain JSON or an SSE stream of `data:` lines. */
export function parseRpcBody(body: string, id: number): { result?: unknown; error?: unknown } {
  const candidates = body.trimStart().startsWith("{")
    ? [body]
    : body
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
  for (const candidate of candidates) {
    try {
      const message = JSON.parse(candidate) as { id?: unknown; result?: unknown; error?: unknown };
      if (message.id === id) return message;
    } catch {
      // Skip keep-alives and partial lines.
    }
  }
  throw new Error(`no JSON-RPC response with id ${id}`);
}
