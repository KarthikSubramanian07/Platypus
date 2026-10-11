import { describe, expect, it } from "vitest";
import { CLASSIFICATION_CLASSES } from "@platypus/shared/contracts";
import { classifyReply, type ClassifyResult } from "./classify";
import { acceptable, evalContext, loadEvalRows, type EvalRow } from "./evals/load";
import { replyModelFromEnv } from "./model";

/**
 * The full pipeline (rules, Claude, thresholds) over every eval row, with a
 * confusion matrix. It spends real API credits, so it runs only through
 * `pnpm --filter @platypus/text eval:model` (which sets EVAL_MODEL=1) and only
 * when ANTHROPIC_API_KEY is set; `pnpm check` skips it.
 */
const enabled = process.env.EVAL_MODEL === "1" && Boolean(process.env.ANTHROPIC_API_KEY);

function confusion(rows: EvalRow[], results: ClassifyResult[]): string {
  const classes = [...CLASSIFICATION_CLASSES];
  const counts = new Map<string, number>();
  rows.forEach((row, i) => {
    const key = `${row.expected_class}|${results[i]!.classification.class}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  const short = (c: string) => c.slice(0, 6).padStart(6);
  const header = `${"expected \\ got".padEnd(20)}${classes.map(short).join(" ")}`;
  const lines = classes.map((e) => `${e.padEnd(20)}${classes.map((g) => String(counts.get(`${e}|${g}`) ?? "").padStart(6)).join(" ")}`);
  return [header, ...lines].join("\n");
}

describe.skipIf(!enabled)("owner-reply eval with the model", () => {
  it("prints a confusion matrix and makes zero false accepts", { timeout: 300_000 }, async () => {
    const model = replyModelFromEnv()!;
    const rows = loadEvalRows();
    const results: ClassifyResult[] = [];
    for (const row of rows) results.push(await classifyReply(row.text, evalContext(row), { model }));

    let correct = 0;
    const falseAccepts: string[] = [];
    const misses: string[] = [];
    rows.forEach((row, i) => {
      const r = results[i]!;
      const ok = acceptable(row).includes(r.classification.class) || (r.action === "clarify" && r.classification.class === "question");
      if (acceptable(row).includes(r.classification.class)) correct++;
      else misses.push(`${row.id} ${JSON.stringify(row.text)} expected ${row.expected_class}, got ${r.classification.class} (${r.method}, ${r.classification.confidence.toFixed(2)})${ok ? " [asked]" : ""}`);
      if (r.action === "confirm" && !acceptable(row).includes("accept")) falseAccepts.push(row.id);
    });

    console.log(`\nmodel: ${model.name}`);
    console.log(confusion(rows, results));
    console.log(`\naccuracy: ${correct}/${rows.length} (${((correct / rows.length) * 100).toFixed(1)}%), false accepts: ${falseAccepts.length}`);
    if (misses.length) console.log(`misses (a clarifying question is a safe miss):\n  ${misses.join("\n  ")}`);
    expect(falseAccepts).toEqual([]);
  });
});
