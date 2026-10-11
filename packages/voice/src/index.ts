import { VOICE_TOOL_NAMES } from "@platypus/shared/contracts";

/**
 * The voice package places Dial calls and serves the VoiceTools contract to
 * Dial's Context MCP so the voice agent can book mid-call.
 */
export const PACKAGE = "@platypus/voice" as const;

export const implementedTools: readonly string[] = VOICE_TOOL_NAMES;
