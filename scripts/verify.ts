/**
 * `pnpm verify`: every check that needs no keys and no network, in one
 * command, ending in a scorecard. Built for a reviewer (human or agent) who
 * wants proof in a few minutes. Exits 1 if any step fails.
 *
 *   pnpm verify           # everything
 *   pnpm verify --quick   # skip the slower end-to-end and differential steps
 */
import { spawnSync } from "node:child_process";

interface Step {
  name: string;
  proves: string;
  cmd: string[];
  slow?: boolean;
  needs?: string;
}

const GOLDEN = "packages/shared/src/testing/fixtures/golden-path.jsonl";

const STEPS: Step[] = [
  { name: "Lint", proves: "ESLint across every package", cmd: ["pnpm", "-s", "lint"] },
  { name: "Typecheck", proves: "strict TypeScript, every package and the CI scripts", cmd: ["pnpm", "-s", "typecheck"] },
  { name: "Unit tests", proves: "state machine, consent, routing, Darwin, Dial, texts, site", cmd: ["pnpm", "-s", "test"] },
  { name: "End to end", proves: "the phone side and the golden path against FakeDial", cmd: ["pnpm", "-s", "test:e2e"], slow: true },
  { name: "Reply classifier eval", proves: "owner texts classified yes, no, time or unclear", cmd: ["pnpm", "-s", "test:eval"] },
  { name: "Golden path fixture", proves: "the recorded demo run has every beat, in order", cmd: ["pnpm", "-s", "ci:golden-path"] },
  { name: "Audit (TypeScript)", proves: "the eight non-negotiables hold on the demo log", cmd: ["pnpm", "-s", "audit:log", GOLDEN, "--no-color"] },
  { name: "Auditors agree (TS and Rust)", proves: "two independent auditors give the same verdict on 1,600+ logs", cmd: ["pnpm", "-s", "ci:audit-diff"], slow: true, needs: "cargo" },
];

const quick = process.argv.includes("--quick");
const has = (bin: string) => spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;

type Result = { step: Step; status: "pass" | "fail" | "skip"; seconds: number; note?: string };
const results: Result[] = [];

for (const step of STEPS) {
  if (quick && step.slow) {
    results.push({ step, status: "skip", seconds: 0, note: "--quick" });
    continue;
  }
  if (step.needs && !has(step.needs)) {
    results.push({ step, status: "skip", seconds: 0, note: `${step.needs} not installed` });
    continue;
  }
  console.log(`\n▶ ${step.name}: ${step.cmd.join(" ")}`);
  const started = Date.now();
  const run = spawnSync(step.cmd[0]!, step.cmd.slice(1), { stdio: "inherit", env: { ...process.env, FORCE_COLOR: "0" } });
  results.push({ step, status: run.status === 0 ? "pass" : "fail", seconds: (Date.now() - started) / 1000 });
}

const mark = { pass: "✓", fail: "✗", skip: "-" } as const;
const width = Math.max(...results.map((r) => r.step.name.length));
console.log("\nPlatypus verify\n");
for (const r of results) {
  const time = r.status === "skip" ? "" : `${r.seconds.toFixed(1)}s`.padStart(7);
  console.log(`  ${mark[r.status]} ${r.step.name.padEnd(width)} ${time}  ${r.note ?? r.step.proves}`);
}
const failed = results.filter((r) => r.status === "fail").length;
const passed = results.filter((r) => r.status === "pass").length;
console.log(`\n${passed} passed, ${failed} failed, ${results.length - passed - failed} skipped.\n`);
process.exit(failed ? 1 : 0);
