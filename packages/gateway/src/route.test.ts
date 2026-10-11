import { describe, expect, it } from "vitest";
import { lookupDarwin } from "@platypus/shared/darwin";
import { darwinFailures, ScriptedDarwin, searchWith, startableAgent } from "@platypus/shared/testing";
import { decideBookingRoute } from "./route";

const phoneOnly = { channel_state: "phone_only", do_not_call: false } as const;
const texting = { channel_state: "text_enabled", do_not_call: false } as const;
const lookup = (darwin: ScriptedDarwin) => lookupDarwin(darwin, { trade: "salon", service: "Haircut", area: "San Francisco" });

describe("decideBookingRoute", () => {
  it("uses Darwin Act when Darwin says a result can start and Platypus holds a pilot token", async () => {
    const darwin = await lookup(new ScriptedDarwin({ script: [searchWith([startableAgent()])] }));
    expect(decideBookingRoute({ business: phoneOnly, darwin, canAct: true }).route).toBe("darwin_act");
  });

  it("never uses Darwin Act without a pilot token, and says why", async () => {
    const darwin = await lookup(new ScriptedDarwin({ script: [searchWith([startableAgent()])] }));
    expect(decideBookingRoute({ business: phoneOnly, darwin, canAct: false })).toEqual({
      route: "call",
      reasons: ["Darwin has a ready agent but Darwin Act is not enabled", "no text consent on record"],
    });
  });

  it("never uses Darwin Act when the ready agent's setup is unknown, and says why", async () => {
    const darwin = await lookup(new ScriptedDarwin({ script: [searchWith([{ ...startableAgent(), requiredSetup: null }])] }));
    expect(decideBookingRoute({ business: phoneOnly, darwin, canAct: true })).toEqual({
      route: "call",
      reasons: ["Darwin has a ready agent, but its setup requirements are unknown", "no text consent on record"],
    });
    // Even a lookup that claims "startable" is re-checked against Darwin's own fields.
    const claimed = { ...darwin, outcome: "startable" as const, candidate: { ...startableAgent(), requiredSetup: null } };
    expect(decideBookingRoute({ business: phoneOnly, darwin: claimed, canAct: true })).toEqual(decideBookingRoute({ business: phoneOnly, darwin, canAct: true }));
  });

  it("calls a phone-only business when Darwin only lists agents (today's live behavior)", async () => {
    const darwin = await lookup(new ScriptedDarwin());
    expect(decideBookingRoute({ business: phoneOnly, darwin, canAct: true })).toEqual({
      route: "call",
      reasons: ["Darwin returned no ready agent", "no text consent on record"],
    });
  });

  it("texts a business whose owner opted in", async () => {
    const darwin = await lookup(new ScriptedDarwin());
    expect(decideBookingRoute({ business: texting, darwin, canAct: false }).route).toBe("text");
  });

  it("still books when Darwin is down", async () => {
    const darwin = await lookup(
      new ScriptedDarwin({ script: [darwinFailures.server500(), darwinFailures.server500(), darwinFailures.server500()] }),
    );
    expect(darwin.outcome).toBe("unavailable");
    expect(decideBookingRoute({ business: phoneOnly, darwin, canAct: true })).toEqual({
      route: "call",
      reasons: ["Darwin unavailable", "no text consent on record"],
    });
  });

  it("works without consulting Darwin at all", () => {
    expect(decideBookingRoute({ business: texting, darwin: null, canAct: false }).reasons).toEqual([
      "Darwin not consulted (DARWIN_ENABLED=false)",
      "owner opted in to texts",
    ]);
  });

  it("never contacts paused, unlisted or do-not-call businesses", () => {
    for (const channel_state of ["paused", "unlisted"] as const) {
      expect(decideBookingRoute({ business: { channel_state, do_not_call: false }, darwin: null, canAct: false }).route).toBeNull();
    }
    expect(decideBookingRoute({ business: { ...phoneOnly, do_not_call: true }, darwin: null, canAct: false }).route).toBeNull();
  });
});
