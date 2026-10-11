import { describe, expect, it } from "vitest";
import { PACKAGE } from "./index";

describe("@platypus/shared", () => {
  it("exposes its package name", () => {
    expect(PACKAGE).toBe("@platypus/shared");
  });
});
