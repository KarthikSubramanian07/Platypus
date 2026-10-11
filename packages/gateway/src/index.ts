import type { Hono } from "hono";
import { GATEWAY_TOOL_NAMES, type OwnerChannels, type SideDeps } from "@platypus/shared/contracts";
import { createDarwin, darwinCacheKey, DarwinLookupCache, isDarwinEnabled, lookupDarwin, type Darwin } from "@platypus/shared/darwin";
import { listBusinesses, seed, type Business } from "@platypus/shared/db";
import { emitSeedEvents } from "@platypus/shared/events";
import { createFakeGateway, createFakeOwnerChannels, FakeDial } from "@platypus/shared/testing";
import { createMcpApp, gatewayToken } from "./mcp";
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
  const lines = [...new Set([...allowedNumbers(env), ...businessPhones])];
  const dial = new FakeDial({
    allowedNumbers: lines,
    // On the Dial-to-Dial rail every simulated owner line counts as a Dial number, as in the phone side's fake.
    ...(textChannel === "dial" ? { dialNumbers: lines } : {}),
    voiceTools: createFakeGateway({ db, bus, textChannel }),
    db,
    bus,
    timeScale: Number(env.FAKE_TIME_SCALE ?? 1),
    autoReply: { body: "Y", afterMs: 4_000 },
  });
  return createFakeOwnerChannels({ dial, db, bus, textChannel });
}

/**
 * AgentSide.mount: the gateway's MCP endpoint at /mcp inside `pnpm dev` (contracts/seams.ts).
 * Throws on a configuration that would silently fake the phone or serve a public /mcp open.
 */
export function mount(app: Hono, deps: SideDeps & { owner?: OwnerChannels }, env: NodeJS.ProcessEnv = process.env): void {
  const { db, bus } = deps;
  if (env.DIAL_IMPL === "real" && !deps.owner) {
    throw new Error("DIAL_IMPL=real, but the phone side does not export createOwnerChannels yet; unset DIAL_IMPL to use the fake owner");
  }
  const token = gatewayToken(env);
  // Idempotent: creates missing businesses and moves the auto shop to ALLOWED_NUMBERS[0] when it changed.
  seed(db, { allowedNumbers: allowedNumbers(env), onSeeded: emitSeedEvents(db, { bus }) });

  const darwin = isDarwinEnabled(env) ? createDarwin(env) : null;
  const darwinCache = new DarwinLookupCache();
  if (darwin && env.DEMO_MODE === "live") warmDarwin(darwin, darwinCache, listBusinesses(db));
  const tools = createGatewayTools({
    db,
    bus,
    owner: deps.owner ?? fakeOwner(deps, env),
    darwin,
    canAct: env.DARWIN_ACT_ENABLED === "true" && Boolean(darwin?.canAct),
    darwinCache,
  });
  app.route("/", createMcpApp(tools, { token: token ?? "" }));
}

/**
 * Live Darwin takes 10 to 30 seconds, so ask once per seeded trade at start and let the stage
 * search hit the cache. Fire-and-forget: startup never waits, and no event is emitted because
 * no agent asked (lookupDarwin itself never emits; consultDarwin does, for agent calls).
 */
function warmDarwin(darwin: Darwin, cache: DarwinLookupCache, businesses: Business[]): void {
  const inputs = new Map(businesses.map((b) => [darwinCacheKey({ trade: b.trade, area: b.service_area ?? undefined }), b]));
  for (const { trade, service_area } of inputs.values()) {
    lookupDarwin(darwin, { trade, area: service_area ?? undefined }, { cache })
      .then((lookup) => {
        if (lookup.outcome === "unavailable") console.warn(`[gateway] Darwin warm-up for ${trade}: unavailable after ${lookup.attempts.length} attempts`);
      })
      .catch((error: unknown) => {
        console.warn(`[gateway] Darwin warm-up for ${trade} failed: ${String(error instanceof Error ? error.message : error).split("\n")[0]}`);
      });
  }
}
