import { describe, expect, it } from "vitest";
import { darwinFailures, FakeDarwin, lookupDarwin, searchWith, startableAgent } from "@platypus/shared/darwin";
import { decideBookingRoute } from "./route";

const phoneOnly = { channel_state: "phone_only", do_not_call: false } as const;
const texting = { channel_state: "text_enabled", do_not_call: false } as const;
const lookup = (darwin: FakeDarwin) => lookupDarwin(darwin, { trade: "salon", service: "Haircut", area: "San Francisco" });

describe("decideBookingRoute", () => {
  it("uses Darwin Act when Darwin says a result can start and Platypus holds a pilot token", async () => {
    const darwin = await lookup(new FakeDarwin({ script: [searchWith([startableAgent()])] }));
    expect(decideBookingRoute({ business: phoneOnly, darwin, canAct: true }).route).toBe("darwin_act");
  });

  it("never uses Darwin Act without a pilot token, and says why", async () => {
    const darwin = await lookup(new FakeDarwin({ script: [searchWith([startableAgent()])] }));
    expect(decideBookingRoute({ business: phoneOnly, darwin, canAct: false })).toEqual({
      route: "call",
      reason: "Darwin has a startable agent but DARWIN_ACT_TOKEN is not set; business is phone-only",
    });
  });

  it("calls a phone-only business when Darwin only lists agents (today's live behavior)", async () => {
    const darwin = await lookup(new FakeDarwin());
    expect(decideBookingRoute({ business: phoneOnly, darwin, canAct: true })).toEqual({
      route: "call",
      reason: "Darwin lists agents but none can start a thread; business is phone-only",
    });
  });

  it("texts a business whose owner opted in", async () => {
    const darwin = await lookup(new FakeDarwin());
    expect(decideBookingRoute({ business: texting, darwin, canAct: false }).route).toBe("text");
  });

  it("still books when Darwin is down", async () => {
    const darwin = await lookup(new FakeDarwin({ script: [darwinFailures.server500(), darwinFailures.server500()] }));
    expect(darwin.outcome).toBe("unavailable");
    expect(decideBookingRoute({ business: phoneOnly, darwin, canAct: true })).toEqual({
      route: "call",
      reason: "Darwin unavailable; business is phone-only",
    });
  });

  it("works without consulting Darwin at all", () => {
    expect(decideBookingRoute({ business: texting, darwin: null, canAct: false }).reason).toBe(
      "Darwin not consulted; owner opted in to texts",
    );
  });

  it("never contacts paused, unlisted or do-not-call businesses", () => {
    for (const channel_state of ["paused", "unlisted"] as const) {
      expect(decideBookingRoute({ business: { channel_state, do_not_call: false }, darwin: null, canAct: false }).route).toBeNull();
    }
    expect(decideBookingRoute({ business: { ...phoneOnly, do_not_call: true }, darwin: null, canAct: false }).route).toBeNull();
  });
});
