import type { Db } from "../db/repo";
import type { Business } from "../db/types";
import { emit, type EmitOptions } from "./log";

/** Seeding is a state change too: each new or changed business becomes a business.listed event. */
export const emitSeedEvents =
  (db: Db, options: EmitOptions = {}) =>
  (business: Business, change: "created" | "updated"): void => {
    emit(
      db,
      {
        type: "business.listed",
        actor: "system",
        refs: { business_id: business.id },
        payload: {
          display_name: business.display_name,
          trade: business.trade,
          channel_state: business.channel_state,
          phone_is_real: business.phone_is_real,
          change,
        },
        reason: change === "created" ? "seeded" : "seed updated the listed number",
      },
      options,
    );
  };
