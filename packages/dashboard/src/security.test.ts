import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Event text is untrusted: owner replies, agent requests, Darwin's descriptions
 * of third parties. The pages build DOM with textContent only (see dom.ts), so
 * no source file may reach for an HTML-parsing sink.
 */
describe("dashboard sources", () => {
  const dir = import.meta.dirname;
  const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  it("never parse event text as HTML", () => {
    expect(sources.length).toBeGreaterThan(3);
    for (const file of sources) {
      const code = readFileSync(join(dir, file), "utf8");
      expect(code, file).not.toMatch(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|createContextualFragment/);
    }
  });
});
