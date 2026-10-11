import { describe, expect, it } from "vitest";
import { PACKAGE } from "./index";

describe("@platypus/text", () => {
  it("compiles against the shared contracts", () => {
    expect(PACKAGE).toBe("@platypus/text");
  });
});
