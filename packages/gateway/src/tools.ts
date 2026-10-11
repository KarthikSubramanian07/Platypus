import {
  BookingError,
  createBooking,
  OCCUPYING_STATUSES,
  placeHold,
  releaseHold,
  transition,
  type BookingContext,
} from "@platypus/shared/booking";
import {
  GATEWAY_TOOLS,
  type BookingView,
  type GatewayContext,
  type GatewayToolName,
  type GatewayTools,
  type OwnerChannels,
  type ProviderSummary,
  type SideDeps,
  type Slot,
} from "@platypus/shared/contracts";
import {
  darwinEventPayload,
  DarwinLookupCache,
  lookupDarwin,
  toDarwinSummary,
  tradeQuery,
  type Darwin,
  type DarwinLookup,
  type DarwinLookupInput,
} from "@platypus/shared/darwin";
import {
  getBusiness,
  getRow,
  listBusinesses,
  selectRows,
  updateRow,
  type Booking,
  type BookingRoute,
  type Business,
  type Hold,
} from "@platypus/shared/db";
import { emit, type EmitInput } from "@platypus/shared/events";
import { sanitizeUntrustedText } from "@platypus/shared/safety";
import { decideBookingRoute } from "./route";
import { computeSignals } from "./signals";

/** The shared Clock type; @platypus/shared exposes it only through BookingContext. */
export type Clock = NonNullable<BookingContext["clock"]>;

export interface GatewayDeps extends SideDeps {
  owner: OwnerChannels;
  /** null when DARWIN_ENABLED=false: Darwin is skipped, never simulated. */
  darwin: Darwin | null;
  /** DARWIN_ACT_ENABLED. darwin_act also needs the Darwin client to hold an Act credential. */
  canAct?: boolean;
  clock?: Clock;
  darwinCache?: DarwinLookupCache;
}

export type GatewayErrorCode =
  | "invalid_request"
  | "rate_limited"
  | "not_found"
  | "no_route"
  | "idempotency_conflict"
  | "too_many_open_requests"
  | "owner_confirmation_required";

/** A refusal the calling agent should read. Booking engine refusals arrive as BookingError. */
export class GatewayError extends Error {
  constructor(
    public readonly code: GatewayErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export const RATE_LIMIT = { calls: 30, windowMs: 60_000 } as const;
/** Idempotency keys and rate-limit buckets idle longer than this are dropped. */
export const STATE_TTL_MS = 60 * 60_000;
/** A business is never asked about more than this many open requests at once, across all agents. */
export const MAX_OPEN_PER_BUSINESS = 3;
const OPEN_STATUSES = ["pending", "countered", "quote_pending"] as const;
/** What the agent hears when the owner channel or Darwin fails; the raw error stays in the event log. */
export const DISPATCH_FAILED_REASON = "could not reach the owner yet; still pending";
const DEFAULT_SLOT_MINUTES = 30;
const MAX_SLOTS = 20;
const OUTCOME_STATUS = { completed: "completed", no_show: "no_show", issue: "disputed" } as const;
const STOPWORDS = new Set(["the", "and", "for", "near", "with", "service", "services", "shop", "book", "need", "appointment", "get"]);

type In<K extends GatewayToolName> = Parameters<GatewayTools[K]>[0];
type Out<K extends GatewayToolName> = Awaited<ReturnType<GatewayTools[K]>>;

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));

function matchesService(business: Business, service: string): boolean {
  const haystack = [business.trade, tradeQuery(business.trade), business.display_name, ...business.services.map((s) => s.name)]
    .join(" ")
    .toLowerCase();
  const query = service.toLowerCase();
  return words(service).some((w) => haystack.includes(w)) || words(haystack).some((w) => w.length >= 4 && query.includes(w));
}

const matchesLocation = (business: Business, location: string) =>
  words(location).some((w) => w.length >= 4 && `${business.address ?? ""} ${business.service_area ?? ""}`.toLowerCase().includes(w));

function serviceMinutes(business: Business, service: string): number {
  const asked = service.toLowerCase();
  const match = business.services.find((s) => asked.includes(s.name.toLowerCase()) || s.name.toLowerCase().includes(asked));
  return match?.duration_minutes ?? DEFAULT_SLOT_MINUTES;
}

function assertRange(range: Slot, what: string): void {
  if (!(Date.parse(range.start) < Date.parse(range.end))) throw new GatewayError("invalid_request", `The ${what} must end after it starts`);
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Opening minutes [open, close] on a weekday from hours like { "mon-fri": "08:00-18:00" }. */
function openMinutes(hours: Record<string, string>, day: string): [number, number] | null {
  const d = DAYS.indexOf(day);
  for (const [days, span] of Object.entries(hours)) {
    const [from = "", to = from] = days.split("-");
    const i = DAYS.indexOf(from);
    const j = DAYS.indexOf(to);
    const open = i >= 0 && j >= 0 && (i <= j ? d >= i && d <= j : d >= i || d <= j);
    const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(span);
    if (open && m) return [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])];
  }
  return null;
}

function withinHours(business: Business, start: Date, minutes: number): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: business.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(start);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const span = openMinutes(business.hours, part("weekday").toLowerCase());
  const at = Number(part("hour")) * 60 + Number(part("minute"));
  return span !== null && at >= span[0] && at + minutes <= span[1];
}

/**
 * The agent-facing tools. Every call is rate limited per agent, validated
 * against the contract, and logged as agent.tool_called. Platypus never
 * confirms a booking here: only the owner's yes, via confirm(), does that.
 */
export function createGatewayTools(deps: GatewayDeps): GatewayTools {
  const { db, bus, owner } = deps;
  const clock: Clock = deps.clock ?? { now: () => new Date() };
  const bookingCtx: BookingContext = { db, bus, clock };
  const darwinCache = deps.darwinCache ?? new DarwinLookupCache(undefined, clock);
  const canAct = Boolean(deps.canAct && deps.darwin?.canAct);
  const record = (input: EmitInput) => emit(db, input, { bus, clock });

  // ponytail: in-memory rate limits and idempotency keys reset on restart; move to a table if the gateway runs as more than one process.
  const recentCalls = new Map<string, number[]>();
  const idempotent = new Map<string, { fingerprint: string; result: Promise<unknown>; at: number }>();

  /** Sweep on access, so neither map grows without bound. */
  function sweep(now: number): void {
    for (const [id, entry] of idempotent) if (now - entry.at > STATE_TTL_MS) idempotent.delete(id);
    for (const [agentId, times] of recentCalls) if (now - (times.at(-1) ?? 0) > STATE_TTL_MS) recentCalls.delete(agentId);
  }

  function checkRate(agentId: string): void {
    const now = clock.now().getTime();
    sweep(now);
    const recent = (recentCalls.get(agentId) ?? []).filter((t) => now - t < RATE_LIMIT.windowMs);
    if (recent.length >= RATE_LIMIT.calls) {
      recentCalls.set(agentId, recent);
      throw new GatewayError("rate_limited", `Too many calls: at most ${RATE_LIMIT.calls} per minute per agent`);
    }
    recentCalls.set(agentId, [...recent, now]);
  }

  /** The same key with the same input returns the original result; with different input it is refused. */
  function once<T>(scope: string, ctx: GatewayContext, key: string, input: unknown, run: () => Promise<T>): Promise<T> {
    const id = JSON.stringify([ctx.agent_id, scope, key]);
    const fingerprint = JSON.stringify(input);
    const hit = idempotent.get(id);
    if (hit) {
      if (hit.fingerprint !== fingerprint) {
        return Promise.reject(new GatewayError("idempotency_conflict", "This idempotency_key was already used with different input"));
      }
      return hit.result as Promise<T>;
    }
    const result = run();
    idempotent.set(id, { fingerprint, result, at: clock.now().getTime() });
    result.catch(() => idempotent.delete(id));
    return result;
  }

  function ownedBooking(bookingId: string, ctx: GatewayContext): Booking {
    const booking = getRow(db, "bookings", bookingId);
    if (!booking || booking.agent_id !== ctx.agent_id) throw new GatewayError("not_found", `Booking not found: ${bookingId}`);
    return booking;
  }

  function logCall(tool: GatewayToolName, input: Record<string, unknown>, ctx: GatewayContext): void {
    const raw = typeof input.booking_id === "string" ? getRow(db, "bookings", input.booking_id) : undefined;
    const booking = raw?.agent_id === ctx.agent_id ? raw : undefined;
    const provider = typeof input.provider_id === "string" ? getBusiness(db, input.provider_id) : undefined;
    const businessId = booking?.business_id ?? provider?.id;
    const fields = Object.entries(input).map(([k, v]) => [k, typeof v === "string" ? sanitizeUntrustedText(v, 200) : v]);
    record({
      type: "agent.tool_called",
      actor: "agent",
      refs: { ...(businessId ? { business_id: businessId } : {}), ...(booking ? { booking_id: booking.id } : {}) },
      payload: { tool, agent_id: ctx.agent_id, ...Object.fromEntries(fields), ...(booking ? { status: booking.status } : {}) },
      reason: tool === "get_booking" ? "agent polled the booking" : `agent called ${tool}`,
    });
  }

  function wrap<K extends GatewayToolName>(tool: K, handler: (input: In<K>, ctx: GatewayContext) => Promise<Out<K>>): GatewayTools[K] {
    const spec = GATEWAY_TOOLS[tool];
    const wrapped = async (raw: In<K>, ctx: GatewayContext): Promise<Out<K>> => {
      if (typeof ctx?.agent_id !== "string" || !ctx.agent_id.trim() || ctx.agent_id.length > 128) {
        throw new GatewayError("invalid_request", "Every call needs a stable agent_id");
      }
      checkRate(ctx.agent_id);
      const input = spec.input.parse(raw) as In<K>;
      logCall(tool, input as Record<string, unknown>, ctx);
      return spec.output.parse(await handler(input, ctx)) as Out<K>;
    };
    return wrapped as unknown as GatewayTools[K];
  }

  // request_booking reuses the answer search_providers just got for the same business, so a slow
  // Darwin (10-20 s on a 500 then a retry) is paid once, not again before the phone rings.
  const recentByBusiness = new Map<string, { at: number; lookup: DarwinLookup }>();
  const RECENT_MS = 10 * 60_000;

  async function consultDarwin(
    input: DarwinLookupInput,
    businessId?: string,
    options: { reuseRecent?: boolean } = {},
  ): Promise<DarwinLookup | null> {
    if (!deps.darwin) return null;
    const now = clock.now().getTime();
    const recent = businessId && options.reuseRecent ? recentByBusiness.get(businessId) : undefined;
    const lookup =
      recent && now - recent.at < RECENT_MS
        ? { ...recent.lookup, cached: true }
        : await lookupDarwin(deps.darwin, input, { cache: darwinCache });
    if (businessId && lookup.outcome !== "unavailable" && !recent) recentByBusiness.set(businessId, { at: now, lookup });
    record({
      type: "darwin.searched",
      actor: "system",
      refs: businessId ? { business_id: businessId } : {},
      payload: { ...darwinEventPayload(lookup), cached: lookup.cached ?? false },
      reason: "Darwin Search v3 consulted before any call",
    });
    return lookup;
  }

  function summarize(business: Business, nextStep: BookingRoute): ProviderSummary {
    const { source, ...numbers } = computeSignals(db, business.id);
    const empty = Object.keys(numbers).length === 0;
    record({
      type: "signals.computed",
      actor: "system",
      refs: { business_id: business.id },
      payload: { source, signals: numbers, ...(empty ? { note: "no history yet" } : {}) },
      reason: "routing signals for the candidate",
    });
    return {
      provider_id: business.id,
      display_name: business.display_name,
      trade: business.trade,
      address: business.address,
      channel_state: business.channel_state,
      services: business.services.map(({ name, typical_price_cents }) => ({ name, typical_price_cents })),
      signals: { source, ...numbers },
      next_step: nextStep,
    };
  }

  function toView(booking: Booking): BookingView {
    return {
      booking_id: booking.id,
      provider_id: booking.business_id,
      provider_name: getBusiness(db, booking.business_id)?.display_name ?? "",
      service: booking.service,
      status: booking.status,
      route: booking.route,
      short_code: booking.short_code,
      window: booking.window_start && booking.window_end ? { start: booking.window_start, end: booking.window_end } : null,
      slot: booking.slot_start && booking.slot_end ? { start: booking.slot_start, end: booking.slot_end } : null,
      price_cents: booking.price_cents,
      confirmed_by: booking.confirmation_evidence?.kind ?? null,
      updated_at: booking.updated_at,
    };
  }

  /** Route text: hold the requested start so nobody else takes it while the owner reads the text. */
  function holdRequestedStart(booking: Booking, business: Business, window: Slot): { hold: Hold | null; reasons: string[] } {
    const start = new Date(window.start);
    const end = Math.min(start.getTime() + serviceMinutes(business, booking.service) * 60_000, Date.parse(window.end));
    try {
      const hold = placeHold(bookingCtx, {
        business_id: business.id,
        booking_id: booking.id,
        slot_start: start.toISOString(),
        slot_end: new Date(end).toISOString(),
        created_by: "system",
      });
      return { hold, reasons: [] };
    } catch (error) {
      if (!(error instanceof BookingError && error.code === "slot_unavailable")) throw error;
      return { hold: null, reasons: ["the requested start is already held or booked; the owner will propose a time"] };
    }
  }

  function reroute(booking: Booking, to: BookingRoute, why: string): void {
    updateRow(db, "bookings", booking.id, { route: to, updated_at: clock.now().toISOString() });
    record({
      type: "booking.route_changed",
      actor: "system",
      refs: { booking_id: booking.id, business_id: booking.business_id },
      payload: { from: booking.route, to, short_code: booking.short_code },
      reason: why,
    });
  }

  async function startAct(booking: Booking, lookup: DarwinLookup | null, idempotencyKey: string): Promise<void> {
    const search = lookup?.search;
    const candidate = lookup?.candidate;
    if (!deps.darwin || !search || !candidate) throw new Error("Darwin Act was chosen without a startable Darwin result");
    // The request travels as data, never as instructions written around the agent's text.
    const message = JSON.stringify({
      type: "booking_request",
      service: booking.service,
      window: { start: booking.window_start, end: booking.window_end },
      requested_by: booking.requested_by,
      reference: booking.short_code,
    });
    const act = await deps.darwin.act(
      { searchId: search.searchId, agentIds: [candidate.agentId], message },
      { idempotencyKey, ...(search.searchToken ? { searchToken: search.searchToken } : {}) },
    );
    record({
      type: "darwin.act_requested",
      actor: "system",
      refs: { booking_id: booking.id, business_id: booking.business_id },
      payload: { agent_id: candidate.agentId, act_request_id: act.actRequestId ?? null, status: act.status ?? null },
      reason: "an existing agent takes the booking through Darwin Act",
    });
  }

  /**
   * Starts the owner contact for the chosen route and returns extra reasons.
   * A failure never loses the booking: it stays pending, and the failure becomes an event.
   */
  async function dispatch(booking: Booking, business: Business, route: BookingRoute, lookup: DarwinLookup | null, window: Slot, idempotencyKey: string): Promise<string[]> {
    const ref = { booking_id: booking.id, business_id: business.id };
    try {
      if (route === "darwin_act") {
        await startAct(booking, lookup, idempotencyKey);
        return [];
      }
      if (route === "call") {
        await owner.startOnboardingCall(ref);
        return [];
      }
      const { hold, reasons } = holdRequestedStart(booking, business, window);
      const sent = await owner.sendBookingRequest(ref);
      if (!("needs_call" in sent)) return reasons;
      const why = sanitizeUntrustedText(sent.reason, 200);
      if (business.do_not_call) throw new Error(`the owner cannot be texted (${why}) and the business is marked do-not-call`);
      if (hold) releaseHold(bookingCtx, hold.id, "system", "the owner will be called instead");
      reroute(booking, "call", `text not possible: ${why}`);
      await owner.startOnboardingCall(ref);
      return ["text not possible; calling instead"];
    } catch (error) {
      const message = sanitizeUntrustedText(error instanceof Error ? error.message : String(error), 200);
      record({
        type: "booking.dispatch_failed",
        actor: "system",
        refs: ref,
        payload: { route, error: message, short_code: booking.short_code },
        reason: "could not reach the owner yet; the booking stays pending",
      });
      return [DISPATCH_FAILED_REASON];
    }
  }

  return {
    search_providers: wrap("search_providers", async (input) => {
      const service = sanitizeUntrustedText(input.service, 120);
      const location = sanitizeUntrustedText(input.location, 200);
      const matched = listBusinesses(db).filter((b) => matchesService(b, service));
      // ponytail: no geocoding; a location that names no seeded service area is ignored rather than guessed at.
      const nearby = matched.filter((b) => matchesLocation(b, location));
      const candidates = nearby.length ? nearby : matched;
      const deadline = input.window?.end;

      const lookups = new Map<string, DarwinLookup | null>();
      const providers: ProviderSummary[] = [];
      for (const business of candidates) {
        if (!lookups.has(business.trade)) {
          const area = business.service_area ?? undefined;
          lookups.set(business.trade, await consultDarwin({ trade: business.trade, service, area, budgetCents: input.budget_cents, deadline }, business.id));
        }
        const { route } = decideBookingRoute({ business, darwin: lookups.get(business.trade) ?? null, canAct });
        if (route) providers.push(summarize(business, route));
      }
      // No local business: still ask Darwin, with the service as the query, so an agent-native route can surface.
      const first = candidates[0];
      const darwin = first ? (lookups.get(first.trade) ?? null) : await consultDarwin({ trade: service, budgetCents: input.budget_cents, deadline });
      return { providers, darwin: toDarwinSummary(darwin) };
    }),

    get_provider: wrap("get_provider", async (input) => {
      const business = getBusiness(db, input.provider_id);
      // ponytail: next_step here skips the Darwin lookup, so it never shows darwin_act; search_providers does the full check.
      const route = business ? decideBookingRoute({ business, darwin: null, canAct: false }).route : null;
      if (!business || !route) throw new GatewayError("not_found", `Provider not found or not taking requests: ${input.provider_id}`);
      return { ...summarize(business, route), hours: business.hours, service_area: business.service_area, timezone: business.timezone };
    }),

    get_availability: wrap("get_availability", async (input) => {
      const business = getBusiness(db, input.provider_id);
      if (!business || business.channel_state === "unlisted") throw new GatewayError("not_found", `Provider not found: ${input.provider_id}`);
      assertRange(input.window, "window");
      if (Object.keys(business.hours).length === 0) return { slots: [], source: "unknown" as const };
      const minutes = business.services[0]?.duration_minutes ?? 60;
      const nowIso = clock.now().toISOString();
      const end = Math.min(Date.parse(input.window.end), Date.parse(input.window.start) + 14 * 86_400_000);
      const first = Math.ceil(Math.max(Date.parse(input.window.start), clock.now().getTime()) / 3_600_000) * 3_600_000;
      const slots: Slot[] = [];
      for (let t = first; t + minutes * 60_000 <= end && slots.length < MAX_SLOTS; t += 3_600_000) {
        const s = new Date(t).toISOString();
        const e = new Date(t + minutes * 60_000).toISOString();
        if (!withinHours(business, new Date(t), minutes)) continue;
        const held = selectRows(db, "holds", "business_id = ? AND status = 'active' AND expires_at > ? AND slot_start < ? AND slot_end > ?", [business.id, nowIso, e, s]);
        const booked = selectRows(
          db,
          "bookings",
          `business_id = ? AND status IN (${OCCUPYING_STATUSES.map(() => "?").join(", ")}) AND slot_start < ? AND slot_end > ?`,
          [business.id, ...OCCUPYING_STATUSES, e, s],
        );
        if (!held.length && !booked.length) slots.push({ start: s, end: e });
      }
      return { slots, source: "template" as const };
    }),

    request_booking: wrap("request_booking", (input, ctx) =>
      once("request_booking", ctx, input.idempotency_key, input, async () => {
        const business = getBusiness(db, input.provider_id);
        if (!business) throw new GatewayError("not_found", `Provider not found: ${input.provider_id}`);
        assertRange(input.window, "window");
        if (Date.parse(input.window.end) <= clock.now().getTime()) throw new GatewayError("invalid_request", "The window has already passed");
        const service = sanitizeUntrustedText(input.service, 120);

        const lookup = await consultDarwin({ trade: business.trade, service, area: business.service_area ?? undefined, deadline: input.window.end }, business.id, { reuseRecent: true });
        const decision = decideBookingRoute({ business, darwin: lookup, canAct });
        if (!decision.route) {
          throw new GatewayError("no_route", `Platypus will not contact ${business.display_name}: ${decision.reasons.join("; ")}`);
        }

        // From here to createBooking nothing awaits, so a retry racing this call sees one or the other.
        const windowStart = new Date(input.window.start).toISOString();
        const windowEnd = new Date(input.window.end).toISOString();
        const open = selectRows(db, "bookings", `business_id = ? AND status IN (${OPEN_STATUSES.map(() => "?").join(", ")})`, [business.id, ...OPEN_STATUSES]);
        // An LLM that retries with a fresh idempotency key gets its open request back, and the owner is not contacted twice.
        const same = open.find(
          (b) =>
            b.agent_id === ctx.agent_id &&
            b.service.toLowerCase() === service.toLowerCase() &&
            b.window_start !== null &&
            b.window_end !== null &&
            b.window_start < windowEnd &&
            b.window_end > windowStart,
        );
        if (same) {
          const reason = `already requested as ${same.short_code} (${same.status}); the owner is not contacted again. Poll get_booking`;
          return { booking_id: same.id, status: "pending" as const, route: same.route ?? decision.route, short_code: same.short_code, reasons: [reason] };
        }
        if (open.length >= MAX_OPEN_PER_BUSINESS) {
          throw new GatewayError(
            "too_many_open_requests",
            `${business.display_name} already has ${open.length} open requests, the most Platypus sends one business at once. Wait for one to be answered or cancel one.`,
          );
        }

        const booking = createBooking(bookingCtx, {
          business_id: business.id,
          agent_id: ctx.agent_id,
          service,
          status: "pending",
          route: decision.route,
          window_start: windowStart,
          window_end: windowEnd,
          // The contract's notes carry details such as the vehicle; the address hint is kept apart.
          details: input.notes ? sanitizeUntrustedText(input.notes) : null,
          notes: input.address_hint ? sanitizeUntrustedText(input.address_hint) : null,
          requested_by: sanitizeUntrustedText(input.requested_by, 120),
          quote_id: input.quote_id ? sanitizeUntrustedText(input.quote_id, 64) : null,
          routing_reasons: decision.reasons,
        });
        const extra = await dispatch(booking, business, decision.route, lookup, input.window, input.idempotency_key);
        const route = getRow(db, "bookings", booking.id)?.route ?? decision.route;
        return { booking_id: booking.id, status: "pending" as const, route, short_code: booking.short_code, reasons: [...decision.reasons, ...extra] };
      }),
    ),

    get_booking: wrap("get_booking", async (input, ctx) => toView(ownedBooking(input.booking_id, ctx))),

    confirm_booking: wrap("confirm_booking", async (input, ctx) => {
      const booking = ownedBooking(input.booking_id, ctx);
      const sameSlot = booking.slot_start === new Date(input.slot.start).toISOString() && booking.slot_end === new Date(input.slot.end).toISOString();
      // A retry after the owner already said yes to this slot is harmless: report the truth.
      if (booking.status === "confirmed" && sameSlot) return toView(booking);
      if (booking.status === "countered") {
        throw new GatewayError(
          "owner_confirmation_required",
          `Booking ${booking.short_code} stays countered: Platypus confirms only on the owner's own yes (on a call, by text, or by a rule they confirmed), never on an agent's word. Poll get_booking.`,
        );
      }
      throw new GatewayError(
        "invalid_request",
        `Booking ${booking.short_code} is ${booking.status}. confirm_booking only answers an owner's counter-offer; only the owner can confirm a booking.`,
      );
    }),

    reschedule_booking: wrap("reschedule_booking", (input, ctx) =>
      once("reschedule_booking", ctx, input.idempotency_key, input, async () => {
        const booking = ownedBooking(input.booking_id, ctx);
        assertRange(input.slot, "slot");
        // The confirmed slot stays on the booking until the owner says yes to the new one.
        const updated = transition(bookingCtx, booking.id, "rescheduled", {
          actor: "agent",
          reason: "agent asked to move the booking",
          payload: { requested_slot: input.slot, agent_id: ctx.agent_id },
        });
        return toView(updated);
      }),
    ),

    cancel_booking: wrap("cancel_booking", (input, ctx) =>
      once("cancel_booking", ctx, input.idempotency_key, input, async () => {
        const booking = ownedBooking(input.booking_id, ctx);
        const updated = transition(bookingCtx, booking.id, "cancelled", {
          actor: "agent",
          reason: "agent cancelled the booking",
          payload: { agent_id: ctx.agent_id, ...(input.reason ? { note: sanitizeUntrustedText(input.reason) } : {}) },
        });
        return toView(updated);
      }),
    ),

    report_outcome: wrap("report_outcome", async (input, ctx) => {
      const booking = ownedBooking(input.booking_id, ctx);
      if (booking.slot_start && Date.parse(booking.slot_start) > clock.now().getTime()) {
        throw new GatewayError("invalid_request", `Booking ${booking.short_code} has not started yet; report the outcome after the appointment`);
      }
      const status = OUTCOME_STATUS[input.outcome];
      transition(bookingCtx, booking.id, status, {
        actor: "agent",
        reason: `agent reported ${input.outcome}`,
        payload: { agent_id: ctx.agent_id, ...(input.notes ? { note: sanitizeUntrustedText(input.notes) } : {}) },
      });
      return { ok: true as const, status };
    }),
  };
}
