import { describe, expect, it } from "vitest";
import { GOLDEN_PATH } from "./fixture";
import type { StreamEvent } from "./format";
import { darwinCaption, DWELL_MS, liveScene, MAX_CAPTION_WORDS, pace, PAYOFF, quoteCaption, SCENES, screenAt, threadAt, wordCount } from "./scenes";
import { initialState, reduceAll, type DarwinView } from "./state";

const upTo = (predicate: (e: StreamEvent) => boolean) => reduceAll(GOLDEN_PATH.slice(0, GOLDEN_PATH.findIndex(predicate) + 1));

describe("SCENES", () => {
  it("numbers step 0, the customer's ask, then the golden path's seven steps, then the payoff", () => {
    expect(SCENES.map((s) => s.step)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", ""]);
    expect(SCENES.map((s) => s.key)).toEqual(["agent", "ask", "darwin", "call", "tools", "yes", "text", "y", "payoff"]);
    expect(DWELL_MS).toHaveLength(SCENES.length);
  });
});

describe("liveScene", () => {
  it("walks the golden path scene by scene, ending on the payoff", () => {
    expect(liveScene(initialState())).toBe(0);
    expect(liveScene(upTo((e) => e.type === "agent.tool_called"))).toBe(1);
    expect(liveScene(upTo((e) => e.type === "darwin.searched"))).toBe(2);
    expect(liveScene(upTo((e) => e.type === "call.placed"))).toBe(3);
    expect(liveScene(upTo((e) => e.type === "voice.tool_called"))).toBe(4);
    expect(liveScene(upTo((e) => e.type === "consent.recorded"))).toBe(5);
    expect(liveScene(upTo((e) => e.type === "call.ended"))).toBe(5);
    expect(liveScene(upTo((e) => e.type === "message.sent"))).toBe(6);
    expect(liveScene(upTo((e) => e.type === "message.received"))).toBe(6);
    expect(liveScene(reduceAll(GOLDEN_PATH))).toBe(PAYOFF);
  });

  it("starts booking the moment the shop answers, before any tool fires", () => {
    const answered = GOLDEN_PATH.findIndex((e) => e.type === "call.status_changed" && e.payload.to === "In-Progress");
    if (answered >= 0) expect(liveScene(reduceAll(GOLDEN_PATH.slice(0, answered + 1)))).toBe(4);
  });

  it("never steps back when the second request asks again", () => {
    const ask = GOLDEN_PATH.find((e) => e.type === "agent.tool_called")!;
    const state = reduceAll([...GOLDEN_PATH.slice(0, GOLDEN_PATH.findIndex((e) => e.type === "call.ended") + 1), { ...ask, id: "evt_brakes" }]);
    expect(state.currentStep).toBe("ask");
    expect(liveScene(state)).toBe(5);
  });
});

describe("pace", () => {
  it("moves one scene at a time, each after its dwell", () => {
    expect(pace(0, 2, 0)).toEqual({ scene: 0, waitMs: DWELL_MS[0] });
    expect(pace(0, 2, DWELL_MS[0])).toEqual({ scene: 1 });
    expect(pace(1, 2, 100)).toEqual({ scene: 1, waitMs: DWELL_MS[1] - 100 });
  });

  it("holds when caught up and jumps back on a replay", () => {
    expect(pace(3, 3, 0)).toEqual({ scene: 3 });
    expect(pace(PAYOFF, 0, 0)).toEqual({ scene: 0 });
  });
});

describe("screenAt", () => {
  const all = reduceAll(GOLDEN_PATH);
  it("shows the customer's agent, the shop's lock screen, the ring, the call, then the thread", () => {
    expect(screenAt(all, 0)).toBe("agent");
    expect(screenAt(initialState(), 0)).toBe("agent");
    expect(screenAt(all, 1)).toBe("lock");
    expect(screenAt(all, 2)).toBe("lock");
    expect(screenAt(upTo((e) => e.type === "call.placed"), 3)).toBe("incoming");
    expect(screenAt(all, 3)).toBe("incoming");
    expect(screenAt(upTo((e) => e.type === "voice.tool_called"), 4)).toBe("call");
    expect(screenAt(all, 5)).toBe("ended");
    expect(screenAt(all, 6)).toBe("messages");
  });

  it("keeps the request alone in the text scene and adds the Y after it", () => {
    expect(threadAt(all, 6).map((m) => m.body.slice(0, 7))).toEqual(["New job"]);
    expect(threadAt(all, 7).map((m) => m.body.slice(0, 7))).toEqual(["New job", "Y"]);
  });
});

describe("captions", () => {
  it("keeps every scripted caption to six words", () => {
    for (const scene of SCENES) expect(wordCount(scene.caption)).toBeLessThanOrEqual(MAX_CAPTION_WORDS);
  });

  it("says only what Darwin's answer supports", () => {
    const answer = (status: DarwinView["status"], agents: DarwinView["agents"] = []) => ({ status, cached: false, agents }) as DarwinView;
    expect(darwinCaption(undefined)).toBe("Darwin first.");
    expect(darwinCaption(answer("error"))).toBe("Darwin didn't answer. We call.");
    expect(darwinCaption(answer("no_match"))).toBe("Darwin: no agent can book it.");
    expect(darwinCaption(answer("completed"))).toBe("Darwin: no agent ready.");
    expect(darwinCaption(answer("completed", [{ id: "a1", canStartThread: true } as DarwinView["agents"][number]]))).toBe("Darwin first. An agent is ready.");
    for (const status of ["error", "disabled", "no_match", "needs_input", "completed"] as const) expect(wordCount(darwinCaption(answer(status)))).toBeLessThanOrEqual(MAX_CAPTION_WORDS);
  });

  it("quotes the shop's yes only when it fits a caption", () => {
    expect(quoteCaption("Yeah, text me.")).toBe("“Yeah, text me.”");
    expect(quoteCaption("Sure, you can text me on this number any time")).toBeUndefined();
    expect(quoteCaption("  ")).toBeUndefined();
    expect(quoteCaption(undefined)).toBeUndefined();
  });
});
