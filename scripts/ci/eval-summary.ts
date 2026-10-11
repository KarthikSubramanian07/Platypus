/**
 * `pnpm ci:eval-summary`: the owner-reply eval as a confusion matrix for the CI job summary.
 *
 * It runs the same pipeline as packages/text/src/evals.test.ts with no model (the
 * deterministic rules, then the safe fallback), so it is free and reproducible. The
 * test file is what enforces the bar (100% on deterministic rows, zero false accepts);
 * this script explains the result and fails on the same two conditions.
 */
import { appendFileSync } from "node:fs";
import { CLASSIFICATION_CLASSES } from "../../packages/shared/src/contracts/classification";
import { classifyDeterministic, classifyReply } from "../../packages/text/src/classify";
import { acceptable, evalContext, loadEvalRows } from "../../packages/text/src/evals/load";

const rows = loadEvalRows();
const counts = new Map<string, number>();
let deterministicRows = 0;
let deterministicCorrect = 0;
let abstainedCorrectly = 0;
const falseAccepts: string[] = [];
const misses: string[] = [];

for (const row of rows) {
  const ctx = evalContext(row);
  const rules = classifyDeterministic(row.text, ctx);
  const out = await classifyReply(row.text, ctx, { model: null });
  const got = out.classification.class;
  counts.set(`${row.expected_class}|${got}`, (counts.get(`${row.expected_class}|${got}`) ?? 0) + 1);

  if (row.deterministic) {
    deterministicRows++;
    if (rules && acceptable(row).includes(rules.classification.class)) deterministicCorrect++;
    else misses.push(`${row.id}: expected ${row.expected_class}, rules said ${rules?.classification.class ?? "nothing"}`);
  } else if (rules === null) abstainedCorrectly++;
  else misses.push(`${row.id}: rules should abstain, said ${rules.classification.class}`);

  if (out.action === "confirm" && !acceptable(row).includes("accept")) falseAccepts.push(row.id);
}

const classes = [...CLASSIFICATION_CLASSES];
const used = classes.filter((c) => [...counts.keys()].some((k) => k.startsWith(`${c}|`) || k.endsWith(`|${c}`)));
const matrix = [
  `| expected \\ got | ${used.join(" | ")} |`,
  `|---|${used.map(() => "---:").join("|")}|`,
  ...used.map((e) => `| **${e}** | ${used.map((g) => {
    const n = counts.get(`${e}|${g}`);
    return n ? (e === g ? `**${n}**` : String(n)) : "·";
  }).join(" | ")} |`),
].join("\n");

const judgmentRows = rows.length - deterministicRows;
const pct = (a: number, b: number) => (b === 0 ? "n/a" : `${((a / b) * 100).toFixed(1)}%`);
const markdown = [
  "### Owner-reply classifier eval (no model)",
  "",
  `| Measure | Result |`,
  `|---|---:|`,
  `| Labeled rows | ${rows.length} |`,
  `| Deterministic rows decided correctly | ${deterministicCorrect}/${deterministicRows} (${pct(deterministicCorrect, deterministicRows)}) |`,
  `| Judgment rows where the rules correctly abstained | ${abstainedCorrectly}/${judgmentRows} |`,
  `| False accepts (a booking confirmed on a non-yes) | ${falseAccepts.length} |`,
  "",
  "Without a model, judgment rows fall back to a clarifying question, which shows up below as `question`.",
  "",
  matrix,
  "",
  misses.length ? `Misses:\n\n${misses.map((m) => `- ${m}`).join("\n")}` : "",
].join("\n");

console.log(markdown);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n\n`);
if (deterministicCorrect !== deterministicRows || falseAccepts.length > 0) process.exitCode = 1;
