import { describe, expect, it } from "vitest";
import { manualClock } from "../clock";
import { newId } from "../ids";
import { getBusinessByNumber, getBusinessBySlug, insertRow, listBusinesses, migrate, openDb, seed, selectRows } from "./index";

const ALLOWED = ["+15550100001", "+15550100002"];

describe("migrations", () => {
  it("apply once and are idempotent", () => {
    const db = openDb(":memory:");
    expect(migrate(db)).toEqual([]);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining(["businesses", "consents", "bookings", "holds", "calls", "messages", "events", "rules"]),
    );
  });

  it("make the event log append-only", () => {
    const db = openDb(":memory:");
    insertRow(db, "events", {
      id: newId("event"),
      type: "test.appended",
      actor: "system",
      business_id: null,
      booking_id: null,
      call_id: null,
      message_id: null,
      consent_id: null,
      hold_id: null,
      payload: {},
      reason: null,
      confidence: 1,
      created_at: new Date().toISOString(),
    });
    expect(() => db.prepare("UPDATE events SET type = 'tampered'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM events").run()).toThrow(/append-only/);
  });

  it("refuse a consent row without its evidence", () => {
    const db = openDb(":memory:");
    const [sal] = seed(db, { allowedNumbers: ALLOWED });
    expect(() =>
      db
        .prepare(
          "INSERT INTO consents (id, business_id, channel, source, quoted_sentence, call_id, created_at) VALUES ('c1', ?, 'imessage', 'call', NULL, NULL, '2026-10-11')",
        )
        .run(sal!.id),
    ).toThrow(/CHECK constraint/);
  });
});

describe("seed", () => {
  it("creates six businesses, all phone-only", () => {
    const db = openDb(":memory:");
    seed(db, { allowedNumbers: ALLOWED, clock: manualClock() });
    const businesses = listBusinesses(db);
    expect(businesses).toHaveLength(6);
    expect(new Set(businesses.map((b) => b.trade))).toEqual(
      new Set(["auto_repair", "salon", "daycare", "mover", "cleaner", "dog_groomer"]),
    );
    expect(businesses.every((b) => b.channel_state === "phone_only")).toBe(true);
  });

  it("gives only the auto shop a real number, taken from ALLOWED_NUMBERS[0]", () => {
    const db = openDb(":memory:");
    seed(db, { allowedNumbers: ALLOWED });
    const real = selectRows(db, "businesses", "phone_is_real = ?", [1]);
    expect(real.map((b) => b.slug)).toEqual(["sals-auto"]);
    expect(getBusinessBySlug(db, "sals-auto")!.phone_e164).toBe(ALLOWED[0]);
    expect(getBusinessByNumber(db, ALLOWED[0]!)!.slug).toBe("sals-auto");
    for (const b of listBusinesses(db).filter((x) => !x.phone_is_real)) {
      expect(b.phone_e164).toMatch(/^\+1\d{3}55501\d{2}$/);
    }
  });

  it("falls back to a fictional number when ALLOWED_NUMBERS is empty", () => {
    const db = openDb(":memory:");
    seed(db, {});
    const sal = getBusinessBySlug(db, "sals-auto")!;
    expect(sal.phone_is_real).toBe(false);
    expect(sal.phone_e164).toBe("+14155550101");
  });

  it("is idempotent and picks up a changed ALLOWED_NUMBERS[0]", () => {
    const db = openDb(":memory:");
    seed(db, { allowedNumbers: ALLOWED });
    const changes: string[] = [];
    seed(db, { allowedNumbers: ["+15550100009"], onSeeded: (b, change) => changes.push(`${b.slug}:${change}`) });
    expect(listBusinesses(db)).toHaveLength(6);
    expect(changes).toEqual(["sals-auto:updated"]);
    expect(getBusinessBySlug(db, "sals-auto")!.phone_e164).toBe("+15550100009");
  });

  it("decodes JSON and boolean columns", () => {
    const db = openDb(":memory:");
    seed(db, { allowedNumbers: ALLOWED });
    const sal = getBusinessBySlug(db, "sals-auto")!;
    expect(sal.services[0]).toEqual({ name: "oil change", typical_price_cents: [7500, 9500], duration_minutes: 45 });
    expect(sal.do_not_call).toBe(false);
    expect(sal.hours["mon-fri"]).toBe("08:00-18:00");
  });
});
