/**
 * `pnpm doctor`: checks that the environment can run Platypus.
 * Prints what is set (never the values of secrets), what is missing, and runs
 * `dial doctor` when the Dial CLI is installed.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { ENV_VARS, maskNumber, parseAllowedNumbers, TEXT_CHANNELS } from "../packages/shared/src/config";
import { DarwinError, HttpDarwin, isDarwinEnabled, probeDarwinMcp } from "../packages/shared/src/darwin";

if (existsSync(".env")) process.loadEnvFile(".env");

const mode = process.env.DEMO_MODE ?? "fakes";
let failures = 0;
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const warn = (msg: string) => console.log(`  • ${msg}`);
const fail = (msg: string) => {
  failures += 1;
  console.log(`  ✗ ${msg}`);
};

console.log(`\nPlatypus doctor (DEMO_MODE=${mode})\n`);

const [major, minor] = process.versions.node.split(".").map(Number);
if ((major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 12)) ok(`Node ${process.versions.node}`);
else fail(`Node ${process.versions.node}: need 22.12 or newer`);

if (!existsSync(".env")) warn(".env not found; copy .env.example to .env");

console.log("\nEnvironment");
for (const v of ENV_VARS) {
  const value = process.env[v.name];
  const needed = v.required === "always" || (v.required === "live" && mode === "live");
  if (value) ok(`${v.name}${v.secret ? " (set)" : ` = ${value}`}`);
  else if (needed) fail(`${v.name} is missing: ${v.purpose}`);
  else warn(`${v.name} not set (${v.required === "optional" ? "optional" : "needed for live mode"})`);
}

console.log("\nSafety rails");
try {
  const allowed = parseAllowedNumbers(process.env.ALLOWED_NUMBERS);
  if (allowed.length === 0) fail("ALLOWED_NUMBERS is empty: nothing can be called or messaged");
  else ok(`ALLOWED_NUMBERS has ${allowed.length} number(s); demo shop is ${maskNumber(allowed[0]!)}`);
} catch (error) {
  fail((error as Error).message);
}
const channel = process.env.TEXT_CHANNEL ?? "imessage";
if ((TEXT_CHANNELS as readonly string[]).includes(channel)) ok(`TEXT_CHANNEL = ${channel}`);
else fail(`TEXT_CHANNEL = ${channel}: must be one of ${TEXT_CHANNELS.join(", ")} (never sms before 10DLC)`);

console.log("\nDarwin");
const darwinImpl = process.env.DARWIN_IMPL ?? (mode === "live" ? "real" : "fake");
const darwinNeeded = darwinImpl === "real" && isDarwinEnabled();
if (!isDarwinEnabled()) warn("DARWIN_ENABLED=false: search_providers reports Darwin as disabled");
const darwinProblem = darwinNeeded ? fail : warn;
// "hair salon" is a query Darwin answers reliably; doctor checks reachability and the key, not ranking.
try {
  const darwin = new HttpDarwin({
    baseUrl: process.env.DARWIN_API_BASE_URL || undefined,
    apiKey: process.env.DARWIN_API_KEY || undefined,
    timeoutMs: 30_000,
  });
  const { search, latencyMs } = await darwin.search({ query: "hair salon", maxResults: 1 });
  ok(`Search v3 answered in ${(latencyMs / 1000).toFixed(1)}s (${search.status}, ${process.env.DARWIN_API_KEY ? "application key accepted" : "anonymous"})`);
} catch (error) {
  const e = error as DarwinError;
  if (e instanceof DarwinError && e.kind === "unauthorized") fail("DARWIN_API_KEY was rejected (401); Darwin never falls back to anonymous");
  else darwinProblem(`Search v3 failed: ${e.message}${e instanceof DarwinError && e.details.requestId ? ` (x-request-id ${e.details.requestId})` : ""}`);
}
const mcp = await probeDarwinMcp();
if (mcp.ok) ok(`MCP server ${mcp.serverVersion} lists ${mcp.tools.length} tools, including search, act and get_thread`);
else darwinProblem(`MCP check failed: ${mcp.error}`);
if (process.env.DARWIN_ACT_TOKEN) ok("DARWIN_ACT_TOKEN set: darwin_act route enabled when Darwin reports a startable agent");
else warn("DARWIN_ACT_TOKEN not set: bookings use call or text (Act is an allowlisted pilot)");
warn(`Darwin client in this mode: ${darwinImpl}`);

console.log("\nDial CLI");
const which = spawnSync("sh", ["-c", "command -v dial"], { encoding: "utf8" });
if (which.status === 0) {
  const result = spawnSync("dial", ["doctor"], { stdio: "inherit" });
  if (result.status === 0) ok("dial doctor passed");
  else fail("dial doctor reported a problem");
} else {
  warn("dial CLI not installed (npm i -g @getdial/cli); skipping dial doctor");
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
