import { describe, expect, it } from "vitest";
import { checkDisclosure, DISCLOSURE } from "./index";

const turn = (speaker: "agent" | "user", text: string, startMs: number) => ({ speaker, text, startMs, endMs: startMs + 1000 });

describe("checkDisclosure", () => {
  it("passes when the agent's first words are the disclosure", () => {
    expect(checkDisclosure([turn("user", "Eddy's Auto, this is Eddy.", 0), turn("agent", `${DISCLOSURE} Is this Eddy's Auto?`, 2000)]).ok).toBe(true);
  });

  it("passes when both sides talk at once and the agent restarts with the full disclosure", () => {
    // From the first real Dial call: the opening "Hi, this" was talked over, then said in full.
    const turns = [
      turn("user", "Hi. This is", 1400),
      turn("agent", "Hi, this", 1400),
      turn("user", "Hi.", 6300),
      turn("agent", `${DISCLOSURE} Is this Eddy's Auto?`, 8700),
    ];
    expect(checkDisclosure(turns)).toMatchObject({ ok: true, similarity: 1 });
  });

  it("fails when the agent says anything else first", () => {
    expect(checkDisclosure([turn("agent", "Hey, quick question about an oil change.", 0), turn("agent", DISCLOSURE, 3000)]).ok).toBe(false);
  });

  it("fails when a clipped start is followed by something other than the disclosure", () => {
    expect(checkDisclosure([turn("agent", "Hi, this", 0), turn("agent", "Do you do oil changes?", 3000)]).ok).toBe(false);
  });

  it("fails when the agent never speaks", () => {
    expect(checkDisclosure([turn("user", "Hello?", 0)])).toMatchObject({ ok: false, first_agent_words: null });
  });
});
