import {
  createMcpHandler,
  isLegacyRequest,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  type CallToolResult,
  type McpRequestContext,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { maskNumber } from "@platypus/shared/config";
import { VOICE_TOOL_NAMES, VOICE_TOOLS, type VoiceToolContext, type VoiceToolName, type VoiceTools } from "@platypus/shared/contracts";
import type { z } from "zod";
import { failureCode, type VoiceToolFailureCode } from "../tools/errors";
import { readDialContext } from "./dial-context";
import { describeResult, spokenError } from "./spoken";

export interface ToolCallLog {
  tool: VoiceToolName;
  ok: boolean;
  code?: VoiceToolFailureCode;
  /** Masked; the raw number never leaves the tool layer. */
  caller_masked: string | null;
  direction: VoiceToolContext["direction"] | null;
  ms: number;
}

export interface ContextMcpServerOptions {
  tools: VoiceTools;
  onToolCall?: (log: ToolCallLog) => void;
  /** Zone for times read aloud in result sentences. Defaults to America/Los_Angeles. */
  timeZone?: string;
}

/** Stands in for a request without Dial identity, so the tools refuse it and log the refusal themselves. */
const NO_CALLER: VoiceToolContext = { caller_number: "", direction: "outbound" };

/**
 * Advertises a zod schema's JSON Schema in tools/list but accepts any arguments.
 * The tools validate input themselves, so a malformed call becomes a speakable
 * error and a voice.tool_called event instead of the SDK's raw validation text.
 */
function advertiseOnly(schema: z.ZodType): StandardSchemaWithJSON {
  const std = schema["~standard"] as unknown as StandardSchemaWithJSON["~standard"];
  return {
    "~standard": {
      version: 1,
      vendor: "platypus",
      validate: (value: unknown) => ({ value }),
      jsonSchema: std.jsonSchema,
    },
  };
}

function textResult(sentence: string, structured: Record<string, unknown>): CallToolResult {
  // One speakable sentence, then compact JSON the model can quote ids from.
  return { content: [{ type: "text", text: `${sentence}\n${JSON.stringify(structured)}` }], structuredContent: structured };
}

/** One McpServer per HTTP request, closed over that request's Dial headers (stateless). */
export function buildContextMcpServer(opts: ContextMcpServerOptions, dial: VoiceToolContext | null): McpServer {
  const server = new McpServer({ name: "platypus-context", version: "1.0.0" });
  const timeZone = opts.timeZone ?? "America/Los_Angeles";
  for (const name of VOICE_TOOL_NAMES) {
    const spec = VOICE_TOOLS[name];
    const impl = opts.tools[name] as (input: unknown, ctx: VoiceToolContext) => Promise<Record<string, unknown>>;
    server.registerTool(
      name,
      {
        description: spec.description,
        inputSchema: advertiseOnly(spec.input),
        outputSchema: spec.output as unknown as StandardSchemaWithJSON,
        annotations: {
          readOnlyHint: name === "check_slot",
          destructiveHint: false,
          // Retries with the same arguments on the same call return the original result.
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input: unknown, ctx): Promise<CallToolResult> => {
        const started = performance.now();
        const who = dial ?? readDialContext(ctx.http?.req?.headers);
        const log = (ok: boolean, code?: VoiceToolFailureCode) =>
          opts.onToolCall?.({
            tool: name,
            ok,
            ...(code ? { code } : {}),
            caller_masked: who ? maskNumber(who.caller_number) : null,
            direction: who?.direction ?? null,
            ms: Math.round(performance.now() - started),
          });
        try {
          const out = await impl(input, who ?? NO_CALLER);
          log(true);
          return textResult(describeResult(name, input, out, { timeZone }), out);
        } catch (error) {
          log(false, failureCode(error));
          return { isError: true, content: [{ type: "text", text: spokenError(error) }] };
        }
      },
    );
  }
  return server;
}

function jsonRpcError(status: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }, { status, headers: { allow: "POST" } });
}

/**
 * The MCP endpoint as a fetch handler. Stateless and JSON-only (no SSE: quick
 * tunnels buffer event streams). 2026-era clients go through createMcpHandler;
 * 2025-era clients, which is what Dial's runtime most likely speaks, get a
 * per-request streamable HTTP transport with JSON responses. GET and DELETE are 405.
 */
export function createContextMcpHandler(opts: ContextMcpServerOptions): (req: Request) => Promise<Response> {
  const factory = (rc: McpRequestContext) => buildContextMcpServer(opts, readDialContext(rc.requestInfo?.headers));
  const modern = createMcpHandler(factory, { legacy: "reject", responseMode: "json" });

  return async (req) => {
    if (!(await isLegacyRequest(req))) return modern.fetch(req);
    if (req.method !== "POST") return jsonRpcError(405, "Method not allowed.");
    const server = factory({ era: "legacy", requestInfo: req });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      void transport.close();
      void server.close();
    }
  };
}
