import { z } from "zod";
import { Classification } from "./classification";
import { GATEWAY_TOOLS } from "./gateway";
import { Signals } from "./signals";
import { TextInbound, TextOutbound } from "./text";
import type { ToolSpec } from "./tool";
import { VOICE_TOOLS } from "./voice";

const toolSchemas = (tools: Record<string, ToolSpec>) =>
  Object.fromEntries(
    Object.entries(tools).map(([name, spec]) => [
      name,
      { description: spec.description, input: z.toJSONSchema(spec.input, { io: "input" }), output: z.toJSONSchema(spec.output) },
    ]),
  );

/** Every contract as JSON Schema, keyed by file name. Written to packages/shared/schemas by `pnpm contracts:export`. */
export function contractJsonSchemas(): Record<string, unknown> {
  return {
    "gateway-tools.json": toolSchemas(GATEWAY_TOOLS),
    "voice-tools.json": toolSchemas(VOICE_TOOLS),
    "text-inbound.json": z.toJSONSchema(TextInbound),
    "text-outbound.json": z.toJSONSchema(TextOutbound),
    "signals.json": z.toJSONSchema(Signals),
    "classification.json": z.toJSONSchema(Classification),
  };
}
