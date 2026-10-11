import { describe, expect, it } from "vitest";
import { createPerryDetector } from "./agent-p";

describe("createPerryDetector", () => {
  const type = (detect: (key: string) => boolean, word: string) => [...word].map(detect);

  it("fires on the last letter of perry, in any case", () => {
    expect(type(createPerryDetector(), "perry")).toEqual([false, false, false, false, true]);
    expect(type(createPerryDetector(), "xxPERRY").at(-1)).toBe(true);
  });

  it("ignores near misses and non-character keys", () => {
    const detect = createPerryDetector();
    expect(type(detect, "pery").some(Boolean)).toBe(false);
    for (const key of ["p", "e", "Shift", "r", "r", "y"]) detect(key);
    expect(type(createPerryDetector(), "perr")).toEqual([false, false, false, false]);
    const shifted = createPerryDetector();
    expect(["p", "e", "Shift", "r", "r", "y"].map(shifted).at(-1)).toBe(true);
  });
});
