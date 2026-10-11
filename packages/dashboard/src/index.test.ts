import { describe, expect, it } from "vitest";
import { PACKAGE } from "./index";

describe("@platypus/dashboard", () => {
  it("compiles", () => {
    expect(PACKAGE).toBe("@platypus/dashboard");
  });
});
