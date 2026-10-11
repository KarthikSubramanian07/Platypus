import { describe, expect, it } from "vitest";
import { PACKAGE } from "./index";

describe("@platypus/keewano", () => {
  it("compiles against the shared contracts", () => {
    expect(PACKAGE).toBe("@platypus/keewano");
  });
});
