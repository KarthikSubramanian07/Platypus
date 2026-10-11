import { describe, expect, it } from "vitest";
import { codeText } from "./copy-code";

describe("codeText", () => {
  it("copies exactly what the block shows, without the trailing newline", () => {
    expect(codeText({ innerText: "pnpm install\npnpm dev\n\n" } as HTMLElement)).toBe("pnpm install\npnpm dev");
  });

  it("falls back to textContent", () => {
    expect(codeText({ innerText: "", textContent: "pnpm check" } as HTMLElement)).toBe("pnpm check");
  });
});
