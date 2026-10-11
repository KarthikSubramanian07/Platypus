/**
 * Typed access to the environment. Every variable in .env.example is listed here
 * so `pnpm doctor` and the runtime agree on what exists.
 */
export const ENV_VARS = [
  { name: "DIAL_API_KEY", required: "live", secret: true, purpose: "Dial API key for calls and messages" },
  { name: "DIAL_FROM_NUMBER_ID", required: "live", secret: false, purpose: "Dial number id calls are placed from" },
  { name: "DIAL_NUMBER", required: "live", secret: false, purpose: "That Dial number in E.164" },
  { name: "DIAL_WEBHOOK_SECRET", required: "live", secret: true, purpose: "Verifies Dial webhook signatures" },
  { name: "DIAL_OWNER_LINE", required: "optional", secret: false, purpose: "Dial-to-Dial: the Dial number standing in for the demo shop's texting line" },
  { name: "DIAL_OWNER_LINE_ID", required: "optional", secret: false, purpose: "Dial-to-Dial: that number's id, for owner replies from the dashboard" },
  { name: "TEXT_CHANNEL", required: "always", secret: false, purpose: "Owner text rail: imessage | whatsapp | dial" },
  { name: "DARWIN_API_KEY", required: "optional", secret: true, purpose: "Darwin application Search key (anonymous search works without it)" },
  { name: "DARWIN_ACT_TOKEN", required: "optional", secret: true, purpose: "Darwin Act pilot OAuth token; used only with DARWIN_ACT_ENABLED=true" },
  { name: "DARWIN_API_BASE_URL", required: "optional", secret: false, purpose: "Darwin API origin (default https://api.darwin.so/api)" },
  { name: "DARWIN_IMPL", required: "optional", secret: false, purpose: "fake | real; overrides DEMO_MODE for Darwin only" },
  { name: "ANTHROPIC_API_KEY", required: "live", secret: true, purpose: "Claude for reply understanding and transcript mining" },
  { name: "CONTEXT_MCP_SECRET", required: "live", secret: true, purpose: "Unguessable path segment of the Context MCP URL" },
  { name: "CONTEXT_MCP_TOKEN", required: "live", secret: true, purpose: "Bearer token Dial sends to the Context MCP" },
  { name: "PUBLIC_BASE_URL", required: "live", secret: false, purpose: "Public HTTPS origin for webhooks and the Context MCP" },
  { name: "GATEWAY_TOKEN", required: "optional", secret: true, purpose: "Bearer token for /mcp; required when PUBLIC_BASE_URL is set" },
  { name: "DASHBOARD_TOKEN", required: "optional", secret: true, purpose: "Opens /events, /audit and /demo/* through the tunnel (?token= or Bearer); without it they answer only this machine" },
  { name: "DASHBOARD_ORIGINS", required: "optional", secret: false, purpose: "Extra browser origins allowed to drive a server on this machine without a token" },
  { name: "HOST", required: "optional", secret: false, purpose: "Interface the server listens on (default 127.0.0.1; cloudflared connects there)" },
  { name: "ALLOWED_NUMBERS", required: "always", secret: true, purpose: "Only numbers Platypus may call or message (E.164, comma-separated)" },
  { name: "DEMO_MODE", required: "always", secret: false, purpose: "fakes | live" },
  { name: "GATEWAY_IMPL", required: "optional", secret: false, purpose: "fake | real: VoiceTools used by the phone side" },
  { name: "DIAL_IMPL", required: "optional", secret: false, purpose: "fake | real: telephony used by the agent side" },
  { name: "DARWIN_ENABLED", required: "optional", secret: false, purpose: "false skips Darwin; it is never simulated" },
  { name: "DARWIN_ACT_ENABLED", required: "optional", secret: false, purpose: "Darwin Act beta handoff" },
] as const;

export type EnvVarName = (typeof ENV_VARS)[number]["name"];

export const TEXT_CHANNELS = ["imessage", "whatsapp", "dial"] as const;
export type TextChannel = (typeof TEXT_CHANNELS)[number];

export const DEMO_MODES = ["fakes", "live"] as const;
export type DemoMode = (typeof DEMO_MODES)[number];

export interface PlatypusConfig {
  textChannel: TextChannel;
  demoMode: DemoMode;
  allowedNumbers: string[];
  publicBaseUrl: string | undefined;
}

const E164 = /^\+[1-9]\d{6,14}$/;

export function parseAllowedNumbers(raw: string | undefined): string[] {
  if (!raw) return [];
  const numbers = raw
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  for (const n of numbers) {
    if (!E164.test(n)) throw new Error(`ALLOWED_NUMBERS contains a value that is not E.164: ${maskNumber(n)}`);
  }
  return numbers;
}

export function isE164(value: string): boolean {
  return E164.test(value);
}

/** Masks a phone number for logs: +14155550123 becomes +1415•••0123. */
export function maskNumber(value: string): string {
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 5)}•••${value.slice(-4)}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PlatypusConfig {
  const textChannel = (env.TEXT_CHANNEL ?? "imessage") as TextChannel;
  if (!TEXT_CHANNELS.includes(textChannel)) {
    throw new Error(`TEXT_CHANNEL must be one of ${TEXT_CHANNELS.join(", ")}; "sms" is not allowed until 10DLC is registered`);
  }
  const demoMode = (env.DEMO_MODE ?? "fakes") as DemoMode;
  if (!DEMO_MODES.includes(demoMode)) {
    throw new Error(`DEMO_MODE must be one of ${DEMO_MODES.join(", ")}`);
  }
  return {
    textChannel,
    demoMode,
    allowedNumbers: parseAllowedNumbers(env.ALLOWED_NUMBERS),
    publicBaseUrl: env.PUBLIC_BASE_URL || undefined,
  };
}
