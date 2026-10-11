/**
 * `pnpm darwin:warm`: run before a demo. Asks live Darwin for every seeded trade,
 * retrying through its intermittent 500s, and saves the answers to
 * darwin-cache/lookups.json (gitignored, search tokens stripped). The gateway
 * loads that file, so the demo's Darwin step answers instantly and is labeled cached.
 */
import { SEED_BUSINESSES } from "../packages/shared/src/db/seed";
import { DARWIN_LOOKUP_CACHE_FILE, DarwinLookupCache, HttpDarwin, warmDarwinLookups } from "../packages/shared/src/darwin";

try {
  process.loadEnvFile(".env");
} catch {
  // .env is optional for Search.
}

const darwin = new HttpDarwin({ baseUrl: process.env.DARWIN_API_BASE_URL || undefined, apiKey: process.env.DARWIN_API_KEY || undefined });
const cache = new DarwinLookupCache({ file: DARWIN_LOOKUP_CACHE_FILE });
const started = Date.now();
const results = await warmDarwinLookups(darwin, cache, SEED_BUSINESSES.map((b) => b.trade), { rounds: 4 });
for (const r of results) console.log(`  ${r.outcome === "unavailable" ? "✗" : "✓"} ${r.trade.padEnd(12)} ${r.outcome.padEnd(12)} after ${r.rounds} round(s)`);
const missing = results.filter((r) => r.outcome === "unavailable");
console.log(`\nWarmed ${results.length - missing.length}/${results.length} trades in ${((Date.now() - started) / 1000).toFixed(1)}s into ${DARWIN_LOOKUP_CACHE_FILE}.`);
if (missing.length) console.log(`Run again for: ${missing.map((m) => m.trade).join(", ")}.`);
process.exit(missing.length ? 1 : 0);
