import { describe, expect, it } from "vitest";
import { classifyDeterministic, classifyReply } from "./classify";
import { acceptable, evalContext, loadEvalRows } from "./evals/load";

const rows = loadEvalRows();
const deterministicRows = rows.filter((r) => r.deterministic);
const modelRows = rows.filter((r) => !r.deterministic);

describe("owner-reply eval set", () => {
  it("has at least 70 labeled rows across every class", () => {
    expect(rows.length).toBeGreaterThanOrEqual(70);
    const classes = new Set(rows.map((r) => r.expected_class));
    for (const c of ["accept", "decline", "counter", "question", "rule_edit", "availability_update", "stop", "help", "pause", "unrelated"]) {
      expect(classes.has(c as never), c).toBe(true);
    }
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  // The brief asks for 95%; the deterministic layer is exact rules, so anything short of 100% is a bug.
  it.each(deterministicRows.map((r) => [r.id, r] as const))("deterministic row %s is decided exactly", (_id, row) => {
    const out = classifyDeterministic(row.text, evalContext(row));
    expect(out, `layer 1 abstained on ${JSON.stringify(row.text)}`).not.toBeNull();
    expect(acceptable(row)).toContain(out!.classification.class);
    if (row.expected_keyword) expect(out!.keyword).toBe(row.expected_keyword);
    else expect(out!.keyword).toBeNull();
    const ex = row.expected_extracted;
    if (ex?.time_iso) expect(new Date(out!.time!.iso!).getTime()).toBe(new Date(ex.time_iso).getTime());
    if (ex?.price_cents !== undefined) expect(out!.classification.extracted?.price_cents).toBe(ex.price_cents);
  });

  it.each(modelRows.map((r) => [r.id, r] as const))("deterministic layer abstains on judgment row %s", (_id, row) => {
    expect(classifyDeterministic(row.text, evalContext(row))).toBeNull();
  });

  it("never auto-confirms a row whose acceptable classes lack accept (deterministic layer and no-model fallback)", async () => {
    const falseAccepts: string[] = [];
    for (const row of rows) {
      const out = await classifyReply(row.text, evalContext(row), { model: null });
      if (out.action === "confirm" && !acceptable(row).includes("accept")) falseAccepts.push(row.id);
    }
    expect(falseAccepts).toEqual([]);
  });

  it("a reaction is never a confirmation", () => {
    for (const row of rows.filter((r) => r.reaction || /^(Liked|Loved|Emphasized|Disliked|Questioned|Laughed at) “/.test(r.text))) {
      expect(classifyDeterministic(row.text, evalContext(row))!.action).not.toBe("confirm");
    }
  });

  it("reports deterministic accuracy", () => {
    let correct = 0;
    for (const row of deterministicRows) {
      const out = classifyDeterministic(row.text, evalContext(row));
      if (out && acceptable(row).includes(out.classification.class)) correct++;
    }
    const accuracy = correct / deterministicRows.length;
    console.log(`deterministic accuracy: ${correct}/${deterministicRows.length} (${(accuracy * 100).toFixed(1)}%)`);
    expect(accuracy).toBe(1);
  });
});
