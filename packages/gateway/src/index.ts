import type { Hono } from "hono";
import { GATEWAY_TOOL_NAMES, type OwnerChannels, type SideDeps } from "@platypus/shared/contracts";
import { createDarwin, isDarwinEnabled } from "@platypus/shared/darwin";
import { seed } from "@platypus/shared/db";
import { emitSeedEvents } from "@platypus/shared/events";
import { createFakeGateway, createFakeOwnerChannels, FakeDial } from "@platypus/shared/testing";
import { createMcpApp } from "./mcp";
import { createGatewayTools } from "./tools";

/**
 * The gateway is the only surface customer agents talk to. It implements the
 * GatewayTools contract from @platypus/shared/contracts over MCP.
 */
export const PACKAGE = "@platypus/gateway" as const;

export const implementedTools: readonly string[] = GATEWAY_TOOL_NAMES;

export { decideBookingRoute, type RouteDecision } from "./route";
export { createGatewayTools, type GatewayDeps } from "./tools";
export { createMcpApp, createMcpServer } from "./mcp";

const allowedNumbers = (env: NodeJS.ProcessEnv): string[] =>
  (env.ALLOWED_NUMBERS ?? "").split(",").map((n) => n.trim()).filter(Boolean);

/**
 * Until DIAL_IMPL=real hands us the phone side, the owner is FakeDial playing the golden-path
 * call against the in-process VoiceTools, and replying Y to texts after a few seconds.
 */
function fakeOwner({ db, bus }: SideDeps, env: NodeJS.ProcessEnv): OwnerChannels {
  const textChannel = env.TEXT_CHANNEL === "whatsapp" || env.TEXT_CHANNEL === "dial" ? env.TEXT_CHANNEL : "imessage";
  const businessPhones = (db.prepare("SELECT phone_e164 FROM businesses").all() as { phone_e164: string }[]).map((b) => b.phone_e164);
  const dial = new FakeDial({
    allowedNumbers: [...new Set([...allowedNumbers(env), ...businessPhones])],
    voiceTools: createFakeGateway({ db, bus, textChannel }),
    db,
    bus,
    timeScale: Number(env.FAKE_TIME_SCALE ?? 1),
    autoReply: { body: "Y", afterMs: 4_000 },
  });
  return createFakeOwnerChannels({ dial, db, bus, textChannel });
}

/** AgentSide.mount: the gateway's MCP endpoint at /mcp inside `pnpm dev` (contracts/seams.ts). */
export function mount(app: Hono, deps: SideDeps & { owner?: OwnerChannels }, env: NodeJS.ProcessEnv = process.env): void {
  const { db, bus } = deps;
  const { n } = db.prepare("SELECT count(*) AS n FROM businesses").get() as { n: number };
  if (n === 0) seed(db, { allowedNumbers: allowedNumbers(env), onSeeded: emitSeedEvents(db, { bus }) });

  const darwin = isDarwinEnabled(env) ? createDarwin(env) : null;
  const tools = createGatewayTools({
    db,
    bus,
    owner: deps.owner ?? fakeOwner(deps, env),
    darwin,
    canAct: env.DARWIN_ACT_ENABLED === "true" && Boolean(darwin?.canAct),
  });
  app.route("/", createMcpApp(tools));
}
