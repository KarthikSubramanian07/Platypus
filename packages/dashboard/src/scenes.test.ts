import { describe, expect, it } from "vitest";
import { GOLDEN_PATH } from "./fixture";
import type { StreamEvent } from "./format";
import { DWELL_MS, liveScene, pace, PAYOFF, screenAt, threadAt } from "./scenes";
import { initialState, reduceAll } from "./state";

const upTo = (predicate: (e: StreamEvent) => boolean) => reduceAll(GOLDEN_PATH.slice(0, GOLDEN_PATH.findIndex(predicate) + 1));

describe("liveScene", () => {
  it("walks the golden path scene by scene, ending on the payoff", () => {
    expect(liveScene(initialState())).toBe(0);
    expect(liveScene(upTo((e) => e.type === "agent.tool_called"))).toBe(0);
    expect(liveScene(upTo((e) => e.type === "darwin.searched"))).toBe(1);
    expect(liveScene(upTo((e) => e.type === "call.placed"))).toBe(2);
    expect(liveScene(upTo((e) => e.type === "consent.recorded"))).toBe(3);
    expect(liveScene(upTo((e) => e.type === "call.ended"))).toBe(3);
    expect(liveScene(upTo((e) => e.type === "message.sent"))).toBe(4);
    expect(liveScene(upTo((e) => e.type === "message.received"))).toBe(4);
    expect(liveScene(reduceAll(GOLDEN_PATH))).toBe(PAYOFF);
  });

  it("never steps back when the second request asks again", () => {
    const ask = GOLDEN_PATH.find((e) => e.type === "agent.tool_called")!;
    const state = reduceAll([...GOLDEN_PATH.slice(0, GOLDEN_PATH.findIndex((e) => e.type === "call.ended") + 1), { ...ask, id: "evt_brakes" }]);
    expect(state.currentStep).toBe("ask");
    expect(liveScene(state)).toBe(3);
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
  it("shows the lock screen until the call, the call through the yes, then the thread", () => {
    expect(screenAt(all, 0)).toBe("lock");
    expect(screenAt(all, 1)).toBe("lock");
    expect(screenAt(upTo((e) => e.type === "call.placed"), 2)).toBe("incoming");
    expect(screenAt(upTo((e) => e.type === "voice.tool_called"), 2)).toBe("call");
    expect(screenAt(all, 3)).toBe("ended");
    expect(screenAt(all, 4)).toBe("messages");
  });

  it("keeps the request alone in the text scene and adds the Y after it", () => {
    expect(threadAt(all, 4).map((m) => m.body.slice(0, 7))).toEqual(["New job"]);
    expect(threadAt(all, 5).map((m) => m.body.slice(0, 7))).toEqual(["New job", "Y"]);
  });
});
