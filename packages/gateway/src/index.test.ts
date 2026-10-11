import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { OwnerChannels } from "@platypus/shared/contracts";
import { getBusinessBySlug, openDb, seed, selectRows, type Db } from "@platypus/shared/db";
import { EventBus, listEvents } from "@platypus/shared/events";
import { mount, PACKAGE } from "./index";

const BASE_ENV = { DARWIN_ENABLED: "false" };
const owner: OwnerChannels = {
  startOnboardingCall: async () => ({ call_id: "call_stub" }),
  sendBookingRequest: async () => ({ message_id: "msg_stub" }),
};

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

const mountWith = (env: NodeJS.ProcessEnv, withOwner = false) =>
  mount(new Hono(), { db, bus: new EventBus(), ...(withOwner ? { owner } : {}) }, { ...BASE_ENV, ...env });

describe("@platypus/gateway", () => {
  it("compiles against the shared contracts", () => {
    expect(PACKAGE).toBe("@platypus/gateway");
  });
});

describe("mount", () => {
  it("refuses DIAL_IMPL=real without the phone side's owner channels instead of faking them", () => {
    expect(() => mountWith({ DIAL_IMPL: "real" })).toThrow(/createOwnerChannels/);
    expect(() => mountWith({ DIAL_IMPL: "real" }, true)).not.toThrow();
  });

  it("refuses a public /mcp without a strong GATEWAY_TOKEN, before touching the database", () => {
    expect(() => mountWith({ PUBLIC_BASE_URL: "https://demo.example", GATEWAY_TOKEN: "" })).toThrow(/GATEWAY_TOKEN/);
    expect(() => mountWith({ PUBLIC_BASE_URL: "https://demo.example", GATEWAY_TOKEN: "too-short" })).toThrow(/GATEWAY_TOKEN/);
    expect(selectRows(db, "businesses")).toEqual([]);
    expect(() => mountWith({ PUBLIC_BASE_URL: "https://demo.example", GATEWAY_TOKEN: "a-long-random-token-1234" })).not.toThrow();
  });

  it("seeds on every mount, moving the auto shop to ALLOWED_NUMBERS[0] and logging only what changed", () => {
    seed(db);
    mountWith({ ALLOWED_NUMBERS: "+15105550123" });
    expect(getBusinessBySlug(db, "sals-auto")?.phone_e164).toBe("+15105550123");
    expect(listEvents(db, { type: "business.listed" }).map((e) => e.payload.change)).toEqual(["updated"]);

    mountWith({ ALLOWED_NUMBERS: "+15105550123" });
    expect(listEvents(db, { type: "business.listed" })).toHaveLength(1);
  });
});
