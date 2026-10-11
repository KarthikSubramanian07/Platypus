import { systemClock, type Clock } from "../clock";
import { maskNumber } from "../config";
import { newId } from "../ids";
import { getBusinessBySlug, insertRow, updateRow, type Db } from "./repo";
import type { Business } from "./types";

/**
 * Six owner-operated businesses. Five use numbers from the 555-0100..0199 range,
 * which is reserved for fiction and never rings anyone. Only the auto shop is
 * real: its number is ALLOWED_NUMBERS[0] (a teammate's phone), read from .env at
 * seed time and never written to the repository.
 */
export const SEED_BUSINESSES = [
  {
    slug: "sals-auto",
    display_name: "Eddy's Auto",
    trade: "auto_repair",
    short_code_prefix: "SAL",
    fictional_phone: "+14155550101",
    address: "North Beach, San Francisco, CA",
    service_area: "San Francisco",
    hours: { "mon-fri": "08:00-18:00", sat: "09:00-14:00" },
    services: [
      { name: "oil change", typical_price_cents: [7500, 9500], duration_minutes: 45 },
      { name: "brake inspection", typical_price_cents: [0, 4900], duration_minutes: 30 },
      { name: "tire rotation", typical_price_cents: [3000, 5000], duration_minutes: 30 },
    ],
  },
  {
    slug: "mira-hair-studio",
    display_name: "Mira Hair Studio",
    trade: "salon",
    short_code_prefix: "MIR",
    fictional_phone: "+14155550102",
    address: "Mission District, San Francisco, CA",
    service_area: "San Francisco",
    hours: { "tue-sat": "10:00-19:00" },
    services: [
      { name: "haircut", typical_price_cents: [5500, 8500], duration_minutes: 45 },
      { name: "color", typical_price_cents: [12000, 22000], duration_minutes: 120 },
    ],
  },
  {
    slug: "little-acorns-daycare",
    display_name: "Little Acorns Daycare",
    trade: "daycare",
    short_code_prefix: "ACN",
    fictional_phone: "+14155550103",
    address: "Inner Sunset, San Francisco, CA",
    service_area: "San Francisco",
    hours: { "mon-fri": "07:30-18:00" },
    services: [
      { name: "drop-in day", typical_price_cents: [9000, 12000], duration_minutes: 600 },
      { name: "tour", typical_price_cents: [0, 0], duration_minutes: 30 },
    ],
  },
  {
    slug: "two-hills-moving",
    display_name: "Two Hills Moving",
    trade: "mover",
    short_code_prefix: "THM",
    fictional_phone: "+14155550104",
    address: "Bayview, San Francisco, CA",
    service_area: "San Francisco Bay Area",
    hours: { "mon-sat": "07:00-19:00" },
    services: [
      { name: "studio move", typical_price_cents: [35000, 60000], duration_minutes: 180 },
      { name: "two-bedroom move", typical_price_cents: [90000, 150000], duration_minutes: 360 },
    ],
  },
  {
    slug: "fresh-start-cleaning",
    display_name: "Fresh Start Cleaning",
    trade: "cleaner",
    short_code_prefix: "FSC",
    fictional_phone: "+14155550105",
    address: "Richmond District, San Francisco, CA",
    service_area: "San Francisco",
    hours: { "mon-sat": "08:00-17:00" },
    services: [
      { name: "standard clean", typical_price_cents: [12000, 18000], duration_minutes: 150 },
      { name: "move-out clean", typical_price_cents: [25000, 40000], duration_minutes: 300 },
    ],
  },
  {
    slug: "dogpatch-groomers",
    display_name: "Dogpatch Groomers",
    trade: "dog_groomer",
    short_code_prefix: "DOG",
    fictional_phone: "+14155550106",
    address: "Dogpatch, San Francisco, CA",
    service_area: "San Francisco",
    hours: { "wed-sun": "09:00-17:00" },
    services: [
      { name: "full groom", typical_price_cents: [7000, 11000], duration_minutes: 90 },
      { name: "bath and brush", typical_price_cents: [4500, 6500], duration_minutes: 60 },
    ],
  },
] as const satisfies ReadonlyArray<{
  slug: string;
  display_name: string;
  trade: string;
  short_code_prefix: string;
  fictional_phone: string;
  address: string;
  service_area: string;
  hours: Record<string, string>;
  services: ReadonlyArray<{ name: string; typical_price_cents: readonly [number, number]; duration_minutes: number }>;
}>;

export const DEMO_SHOP_SLUG = "sals-auto";

export interface SeedOptions {
  /** ALLOWED_NUMBERS; element 0 becomes the auto shop's real phone. */
  allowedNumbers?: readonly string[];
  clock?: Clock;
  /** Called once per business that was created or changed, so callers can emit events. */
  onSeeded?: (business: Business, change: "created" | "updated") => void;
}

export function seed(db: Db, options: SeedOptions = {}): Business[] {
  const clock = options.clock ?? systemClock;
  const realPhone = options.allowedNumbers?.[0];
  const now = clock.now().toISOString();
  return db.transaction(() =>
    SEED_BUSINESSES.map((def) => {
      const isDemoShop = def.slug === DEMO_SHOP_SLUG;
      const phone = isDemoShop && realPhone ? realPhone : def.fictional_phone;
      const existing = getBusinessBySlug(db, def.slug);
      if (existing) {
        if (existing.phone_e164 === phone) return existing;
        const updated = updateRow(db, "businesses", existing.id, {
          phone_e164: phone,
          phone_is_real: isDemoShop && Boolean(realPhone),
          updated_at: now,
        });
        options.onSeeded?.(updated, "updated");
        return updated;
      }
      const business: Business = {
        id: newId("business", clock.now().getTime()),
        slug: def.slug,
        display_name: def.display_name,
        trade: def.trade,
        phone_e164: phone,
        phone_is_real: isDemoShop && Boolean(realPhone),
        text_number_e164: null,
        short_code_prefix: def.short_code_prefix,
        services: def.services.map((s) => ({ ...s, typical_price_cents: [...s.typical_price_cents] as [number, number] })),
        address: def.address,
        service_area: def.service_area,
        hours: { ...def.hours },
        timezone: "America/Los_Angeles",
        channel_state: "phone_only",
        channel_pref: null,
        do_not_call: false,
        created_at: now,
        updated_at: now,
      };
      insertRow(db, "businesses", business);
      options.onSeeded?.(business, "created");
      return business;
    }),
  )();
}

export function describeSeed(businesses: Business[]): string {
  return businesses
    .map((b) => `${b.display_name.padEnd(24)} ${b.trade.padEnd(12)} ${maskNumber(b.phone_e164)}${b.phone_is_real ? "  (real)" : ""}`)
    .join("\n");
}
