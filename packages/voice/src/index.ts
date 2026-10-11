import type { Hono } from "hono";
import { VOICE_TOOL_NAMES, type OwnerChannels, type SideDeps } from "@platypus/shared/contracts";
import { createPhoneSide, type PhoneSide } from "./phone-side";

/**
 * The phone side: places the one onboarding call through Dial, serves the VoiceTools
 * contract to Dial's Context MCP so the voice agent books mid-call, and reaches owners
 * by text after they say yes. scripts/dev.ts plugs it in through mount() and
 * createOwnerChannels() (packages/shared/src/contracts/seams.ts).
 */
export const PACKAGE = "@platypus/voice" as const;

export const implementedTools: readonly string[] = VOICE_TOOL_NAMES;

// One phone side per process: mount() and createOwnerChannels() must share the call service.
const instances = new WeakMap<SideDeps["db"], PhoneSide>();

function phoneSideFor(deps: SideDeps): PhoneSide {
  let side = instances.get(deps.db);
  if (!side) {
    side = createPhoneSide(deps, { text: textFactory });
    instances.set(deps.db, side);
  }
  return side;
}

let textFactory: Parameters<typeof createPhoneSide>[1] extends infer O ? (O extends { text?: infer T } ? T : never) : never;

/** Lets the process attach the text side before mount() runs. */
export function useTextSide(factory: NonNullable<typeof textFactory>): void {
  textFactory = factory;
}

export function mount(app: Hono, deps: SideDeps): void {
  phoneSideFor(deps).mount(app);
}

export function createOwnerChannels(deps: SideDeps): OwnerChannels {
  return phoneSideFor(deps).owner;
}

export { createPhoneSide, type PhoneSide, type PhoneSideOptions, type TextSide } from "./phone-side";
export * from "./call/index";
export * from "./context-mcp/index";
export { createVoiceTools } from "./tools/voice-tools";
