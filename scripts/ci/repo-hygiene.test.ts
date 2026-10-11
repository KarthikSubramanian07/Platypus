import { describe, expect, it } from "vitest";
import { findAttribution, findPhoneNumbers, findTodos, isCommittedEnvFile, isFictionalNumber } from "./repo-hygiene";

// Real-format numbers are assembled at runtime so this file never trips the scanner it tests.
const real = (...parts: string[]) => `+${parts.join("")}`;

describe("isCommittedEnvFile", () => {
  it("flags env files anywhere in the tree", () => {
    for (const p of [".env", ".env.local", "packages/voice/.env.production"]) expect(isCommittedEnvFile(p), p).toBe(true);
  });
  it("allows templates and lookalikes", () => {
    for (const p of [".env.example", "packages/x/.env.sample", "env.ts", ".envrc.md", "src/dotenv.ts"]) expect(isCommittedEnvFile(p), p).toBe(false);
  });
});

describe("isFictionalNumber", () => {
  it("accepts the reserved fictional ranges", () => {
    for (const n of ["+14155550101", "+12125550199", "+15550100000", "+15559999999", "+14155559876"]) expect(isFictionalNumber(n), n).toBe(true);
  });
  it("rejects numbers that could ring a real phone", () => {
    for (const n of [real("1", "212", "5550200"), real("1", "650", "2530000"), real("44", "7700", "900123"), real("1", "212", "5551234")]) {
      expect(isFictionalNumber(n), n).toBe(false);
    }
  });
});

describe("findPhoneNumbers", () => {
  it("reports only real-looking E.164 numbers, with line numbers", () => {
    const text = ["ALLOWED_NUMBERS=+14155550101", `owner: ${real("1", "650", "2530000")}`, "price +1200 and id abc+12345678901x"].join("\n");
    expect(findPhoneNumbers(text)).toEqual([{ number: real("1", "650", "2530000"), line: 2 }]);
  });
});

describe("findAttribution", () => {
  it("catches AI co-author trailers and generated-with footers", () => {
    expect(findAttribution("Fix it\n\nCo-Authored-By: Claude <noreply@anthropic.com>")).toMatch(/Co-Authored-By/);
    expect(findAttribution("Fix it\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)")).toMatch(/Generated with/);
    expect(findAttribution("Fix\n\nco-authored-by: GitHub Copilot <copilot@github.com>")).not.toBeNull();
  });
  it("leaves human co-authors and ordinary prose alone", () => {
    expect(findAttribution("Pair on routing\n\nCo-Authored-By: Eddy Lee <eddy@example.com>")).toBeNull();
    expect(findAttribution("Render the generated schemas with zod")).toBeNull();
  });
});

describe("findTodos", () => {
  it("finds TODO and FIXME as words only", () => {
    expect(findTodos("a\n// TODO: later\nconst todos = 1\n/* FIXME */")).toEqual([2, 4]);
  });
});
