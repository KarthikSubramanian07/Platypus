/**
 * `pnpm darwin:smoke`: exercises live Darwin the way the gateway will.
 * For each seeded business it runs the real search ladder, then checks Darwin's
 * MCP server. Writes a report to darwin-cache/ (gitignored). Exits 1 only when
 * Darwin is unusable: MCP down, a rejected key, or no business got an answer.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { decideBookingRoute } from "../packages/gateway/src/route";
import { SEED_BUSINESSES } from "../packages/shared/src/db/seed";
import { DarwinLookupCache, HttpDarwin, lookupDarwin, probeDarwinMcp, warmDarwinLookups, type DarwinLookup } from "../packages/shared/src/darwin";

const env = process.env;
try {
  process.loadEnvFile(".env");
} catch {
  // .env is optional for Search.
}

const darwin = new HttpDarwin({
  baseUrl: env.DARWIN_API_BASE_URL || undefined,
  apiKey: env.DARWIN_API_KEY || undefined,
  actToken: env.DARWIN_ACT_ENABLED === "true" ? env.DARWIN_ACT_TOKEN || undefined : undefined,
});

console.log(`\nDarwin smoke (${env.DARWIN_API_KEY ? "application key" : "anonymous"} Search, Act ${darwin.canAct ? "configured" : "not configured"})\n`);

const rows: Array<{ slug: string; lookup: DarwinLookup; route: string }> = [];
for (const business of SEED_BUSINESSES) {
  const lookup = await lookupDarwin(darwin, {
    trade: business.trade,
    service: business.services[0]?.name,
  });
  const decision = decideBookingRoute({ business: { channel_state: "phone_only", do_not_call: false }, darwin: lookup, canAct: darwin.canAct });
  rows.push({ slug: business.slug, lookup, route: decision.route ?? "none" });
  const trail = lookup.attempts.map((a) => `${a.ok ? "200" : (a.status ?? a.errorKind)} ${(a.latencyMs / 1000).toFixed(1)}s`).join(" → ");
  const agents = lookup.search?.response.agents ?? [];
  const startable = agents.filter((a) => a.canStartThread).length;
  console.log(
    `  ${lookup.outcome === "unavailable" ? "✗" : "✓"} ${business.slug.padEnd(22)} ${lookup.outcome.padEnd(12)} ` +
      `${String(agents.length).padStart(2)} agents, ${startable} startable  route=${decision.route ?? "none"}  [${trail}]`,
  );
  for (const a of lookup.attempts.filter((x) => !x.ok)) {
    console.log(`      rung "${a.query}"${a.withContext ? " +context" : ""} failed: ${a.status ?? a.errorKind}, x-request-id ${a.requestId ?? "n/a"}`);
  }
}

// The demo path as the gateway runs it: warm the bare trades at startup, then the
// agent's request is answered inside the six-second budget from docs/workstreams.md.
console.log("\nDemo path (warm cache, then a 6 s budget)");
const cache = new DarwinLookupCache();
const warmStarted = Date.now();
const warmed = await warmDarwinLookups(darwin, cache, SEED_BUSINESSES.map((b) => b.trade), { rounds: 4 });
console.log(`  • warm-up took ${((Date.now() - warmStarted) / 1000).toFixed(1)}s: ${warmed.map((w) => `${w.trade}=${w.outcome}`).join(", ")}`);
const demoStarted = Date.now();
const demo = await lookupDarwin(darwin, { trade: "auto_repair", service: "oil change", budgetCents: 12000, deadline: new Date(Date.now() + 86_400_000) }, { cache, budgetMs: 6000 });
const demoMs = Date.now() - demoStarted;
const demoOk = demoMs < 6000 && !demo.timedOut;
console.log(`  ${demoOk ? "✓" : "✗"} demo lookup answered in ${demoMs}ms: ${demo.outcome}${demo.cached ? " (cached)" : ""}${demo.timedOut ? " (timed out)" : ""}`);

console.log("\nDarwin MCP (https://mcp.darwin.so/mcp)");
const mcp = await probeDarwinMcp();
if (mcp.ok) console.log(`  ✓ server ${mcp.serverVersion}, protocol ${mcp.protocolVersion}, ${mcp.tools.length} tools: ${mcp.tools.join(", ")}`);
else console.log(`  ✗ ${mcp.error}`);

mkdirSync("darwin-cache", { recursive: true });
const reportPath = `darwin-cache/smoke-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(
  reportPath,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      mcp,
      demo: { ms: demoMs, outcome: demo.outcome, cached: demo.cached ?? false, timedOut: demo.timedOut ?? false, warmed },
      lookups: rows.map((r) => ({
        slug: r.slug,
        outcome: r.lookup.outcome,
        route: r.route,
        attempts: r.lookup.attempts,
        searchId: r.lookup.search?.searchId ?? null,
        agents: (r.lookup.search?.response.agents ?? []).map((a) => ({
          agentId: a.agentId,
          capabilityId: a.capabilityId,
          name: a.name,
          readiness: a.readiness,
          canStartThread: a.canStartThread,
        })),
      })),
    },
    null,
    2,
  ),
);

const answered = rows.filter((r) => r.lookup.outcome !== "unavailable").length;
const configError = rows.find((r) => r.lookup.configError)?.lookup.configError;
console.log(`\n${answered}/${rows.length} businesses got a Darwin answer. Report: ${reportPath}`);
if (configError) console.log(`Darwin rejected the configured credentials (${configError}); check DARWIN_API_KEY.`);
const healthy = mcp.ok && !configError && answered > 0;
console.log(healthy ? "Darwin is usable.\n" : "Darwin is NOT usable; the gateway will route every booking on its own.\n");
process.exit(healthy ? 0 : 1);
