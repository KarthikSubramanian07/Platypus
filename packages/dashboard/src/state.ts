import { stepFor, type StepKey, type StreamEvent } from "./format";

/**
 * Everything /live shows, derived from the event stream and nothing else.
 *
 * `reduce(state, event)` is pure: it never mutates its input and never reads the
 * clock, so a refresh that replays the history rebuilds exactly the same state,
 * and a duplicate delivered across a reconnect changes nothing. Entities are keyed
 * by their own ids (business_id, booking_id, call_id, message_id), so replaying the
 * same run twice converges instead of doubling up.
 *
 * Payloads are read defensively: a missing or oddly typed field becomes undefined,
 * never an exception, and nothing is filled in that the events did not say.
 */

export const VOICE_TOOLS = ["check_slot", "hold_slot", "create_booking", "record_consent", "set_text_number"] as const;
export type VoiceTool = (typeof VOICE_TOOLS)[number];

export const DARWIN_STATUSES = ["completed", "needs_input", "no_match", "error", "disabled"] as const;
export type DarwinStatus = (typeof DARWIN_STATUSES)[number] | "unknown";

/** Longest piece of untrusted text kept in state; the rest is cut with an ellipsis. */
const MAX_TEXT = 400;
/** The compact event stream keeps the most recent events only. */
export const MAX_EVENTS = 200;

export interface AskView {
  tool: string;
  agentId?: string;
  service?: string;
  location?: string;
  budgetCents?: number;
  windowStart?: string;
  windowEnd?: string;
  /** The customer's own words, when the agent passed them as the event reason. */
  utterance?: string;
  at: string;
}

export interface DarwinAgentView {
  id: string;
  rank: number;
  name?: string;
  readiness: string;
  canStartThread: boolean;
  reasons: string[];
  uncertainties: string[];
}

export interface DarwinAttemptView {
  query?: string;
  ok: boolean;
  status?: number;
  errorKind?: string;
  latencyMs?: number;
  withContext: boolean;
}

export interface DarwinView {
  status: DarwinStatus;
  /** The status string exactly as the event carried it. */
  rawStatus?: string;
  httpStatus?: number;
  latencyMs?: number;
  cached: boolean;
  provenance?: string;
  recordedAt?: string;
  query?: string;
  searchId?: string;
  outcome?: string;
  candidateAgentId?: string;
  noMatchReason?: string;
  question?: string;
  configError?: string;
  agents: DarwinAgentView[];
  attempts: DarwinAttemptView[];
  at: string;
}

export interface RoutingView {
  bookingId: string;
  route?: string;
  shortCode?: string;
  reasons: string[];
  at: string;
}

export interface SignalsView {
  businessId?: string;
  source?: string;
  note?: string;
  entries: [string, string][];
  at: string;
}

export interface BusinessView {
  id: string;
  name: string;
  trade?: string;
  channel: string;
  rail?: string;
  numberMasked?: string;
  consentQuote?: string;
  consentSource?: string;
  channelChangedAt?: string;
  lastPriceCents?: number;
  consents: { id: string; callId?: string }[];
  callIds: string[];
}

export interface ToolSlot {
  state: "idle" | "ok" | "failed";
  at?: string;
  error?: string;
}

export interface TranscriptTurn {
  speaker: "agent" | "owner";
  text: string;
  startMs?: number;
  endMs?: number;
}

export interface CallView {
  id: string;
  businessId?: string;
  bookingId?: string;
  dialCallId?: string;
  state: string;
  scriptVersion: string;
  maxSeconds?: number;
  placedAt: string;
  ringingAt?: string;
  inProgressAt?: string;
  endedAt?: string;
  durationSeconds?: number;
  endStatus?: string;
  canceled?: boolean;
  tools: Record<VoiceTool, ToolSlot>;
  /** Tools outside the five fixed slots, in call order. */
  otherTools: { tool: string; ok: boolean; at: string }[];
  transcript?: TranscriptTurn[];
}

export interface BookingView {
  id: string;
  businessId?: string;
  shortCode?: string;
  service?: string;
  route?: string;
  status: string;
  windowStart?: string;
  windowEnd?: string;
  slotStart?: string;
  slotEnd?: string;
  priceCents?: number;
  evidence?: { kind: string; quote?: string; messageId?: string; callId?: string };
  /** Why the gateway routed it to a call or a text, as booking.pending said. */
  reasons: string[];
  /** When the booking.confirmed event landed, for "confirmed in 4 s". */
  confirmedAt?: string;
  /** True when any booking event for it said source "transcript" (the post-call fallback path). */
  fromTranscript: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MessageView {
  id: string;
  businessId?: string;
  bookingId?: string;
  direction: "out" | "in";
  body: string;
  channel?: string;
  status: string;
  at: string;
  classification?: { class: string; method?: string; confidence: number };
}

export interface DashboardState {
  seen: ReadonlySet<string>;
  events: StreamEvent[];
  eventCount: number;
  /** True once any event was a replay of the fixture, so the page can say so. */
  replayed: boolean;
  ask?: AskView;
  darwin?: DarwinView;
  routing?: RoutingView;
  signals?: SignalsView;
  businesses: Record<string, BusinessView>;
  businessOrder: string[];
  calls: Record<string, CallView>;
  lastCallId?: string;
  bookings: Record<string, BookingView>;
  bookingOrder: string[];
  messages: MessageView[];
  reached: StepKey[];
  currentStep?: StepKey;
}

export function initialState(): DashboardState {
  return {
    seen: new Set(),
    events: [],
    eventCount: 0,
    replayed: false,
    businesses: {},
    businessOrder: [],
    calls: {},
    bookings: {},
    bookingOrder: [],
    messages: [],
    reached: [],
  };
}

// ---- Defensive readers ------------------------------------------------------------

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined;
}
function str(v: unknown, max = MAX_TEXT): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function strings(v: unknown, limit: number): string[] {
  return list(v)
    .map((x) => str(x, 300))
    .filter((x): x is string => x !== undefined)
    .slice(0, limit);
}
/** The first defined value among snake_case and camelCase spellings. */
function pick(p: Obj, ...keys: string[]): unknown {
  for (const k of keys) if (p[k] !== undefined && p[k] !== null) return p[k];
  return undefined;
}
function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

// ---- Entity readers ------------------------------------------------------------------

export function readDarwin(event: StreamEvent): DarwinView {
  const p = event.payload;
  const rawStatus = str(p.status, 40);
  const status: DarwinStatus = (DARWIN_STATUSES as readonly string[]).includes(rawStatus ?? "") ? (rawStatus as DarwinStatus) : "unknown";
  const agents = list(p.agents)
    .map(obj)
    .filter((a): a is Obj => a !== undefined)
    .map((a, i): DarwinAgentView =>
      dropUndefined({
        id: str(pick(a, "agent_id", "agentId", "id"), 120) ?? `agent-${i + 1}`,
        rank: num(a.rank) ?? i + 1,
        name: str(a.name, 120),
        readiness: str(a.readiness, 40) ?? "unknown",
        canStartThread: bool(pick(a, "can_start_thread", "canStartThread")) ?? false,
        reasons: strings(a.reasons, 3),
        uncertainties: strings(a.uncertainties, 2),
      }),
    )
    .sort((a, b) => a.rank - b.rank);
  const attempts = list(p.attempts)
    .map(obj)
    .filter((a): a is Obj => a !== undefined)
    .map(
      (a): DarwinAttemptView =>
        dropUndefined({
          query: str(a.query, 160),
          ok: bool(a.ok) ?? false,
          status: num(a.status),
          errorKind: str(pick(a, "errorKind", "error_kind"), 40),
          latencyMs: num(pick(a, "latencyMs", "latency_ms")),
          withContext: bool(pick(a, "withContext", "with_context")) ?? false,
        }),
    );
  return dropUndefined({
    status,
    rawStatus,
    httpStatus: num(pick(p, "http_status", "httpStatus")),
    latencyMs: num(pick(p, "latency_ms", "latencyMs")),
    cached: p.cached === true,
    provenance: str(p.provenance, 40),
    recordedAt: str(pick(p, "recorded_at", "recordedAt"), 40),
    query: str(p.query, 300),
    searchId: str(pick(p, "search_id", "searchId"), 120),
    outcome: str(p.outcome, 40),
    candidateAgentId: str(pick(p, "candidate_agent_id", "candidateAgentId"), 120),
    noMatchReason: str(pick(p, "no_match_reason", "noMatchReason")),
    question: str(p.question),
    configError: str(pick(p, "config_error", "configError"), 40),
    agents,
    attempts,
    at: event.created_at,
  });
}

/** The turns of a call.transcribed payload, in call order. Exported so the recorded run can caption the call as it plays. */
export function readTranscript(payload: Obj): TranscriptTurn[] {
  return list(payload.turns)
    .map(obj)
    .filter((t): t is Obj => t !== undefined)
    .map((t): TranscriptTurn | undefined => {
      const text = str(t.text, 600);
      if (!text) return undefined;
      const speaker = str(pick(t, "speaker", "role"), 20)?.toLowerCase();
      return dropUndefined({
        // Dial labels the person who answered "user"; on this screen that is the owner.
        speaker: speaker === "agent" || speaker === "assistant" || speaker === "ai" ? "agent" : "owner",
        text,
        startMs: num(pick(t, "startMs", "start_ms")),
        endMs: num(pick(t, "endMs", "end_ms")),
      }) as TranscriptTurn;
    })
    .filter((t): t is TranscriptTurn => t !== undefined)
    .sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
}

function emptyTools(): Record<VoiceTool, ToolSlot> {
  return Object.fromEntries(VOICE_TOOLS.map((t) => [t, { state: "idle" }])) as Record<VoiceTool, ToolSlot>;
}

function newCall(id: string, event: StreamEvent): CallView {
  return dropUndefined({
    id,
    businessId: str(event.refs.business_id, 80),
    bookingId: str(event.refs.booking_id, 80),
    state: "Queued",
    scriptVersion: "v1",
    placedAt: event.created_at,
    tools: emptyTools(),
    otherTools: [],
  });
}

function newBusiness(id: string): BusinessView {
  return { id, name: id, channel: "phone_only", consents: [], callIds: [] };
}

function newBooking(id: string, event: StreamEvent): BookingView {
  return { id, businessId: str(event.refs.business_id, 80), status: "pending", reasons: [], fromTranscript: false, createdAt: event.created_at, updatedAt: event.created_at };
}

function append<T>(items: readonly T[], item: T): T[] {
  return items.includes(item) ? [...items] : [...items, item];
}

// ---- The reducer ---------------------------------------------------------------------

export function reduce(state: DashboardState, event: StreamEvent): DashboardState {
  if (state.seen.has(event.id)) return state;
  const seen = new Set(state.seen);
  seen.add(event.id);
  const events = state.events.length >= MAX_EVENTS ? [...state.events.slice(state.events.length - MAX_EVENTS + 1), event] : [...state.events, event];
  let next: DashboardState = { ...state, seen, events, eventCount: state.eventCount + 1, replayed: state.replayed || event.payload.replayed === true };

  const step = stepFor(event);
  if (step) next = { ...next, reached: append(next.reached, step), currentStep: step };

  return applyEvent(next, event);
}

/** Folds a whole history, as a refresh does. */
export function reduceAll(events: readonly StreamEvent[], state: DashboardState = initialState()): DashboardState {
  return events.reduce(reduce, state);
}

function applyEvent(state: DashboardState, event: StreamEvent): DashboardState {
  const p = event.payload;
  const refs = event.refs;
  const [kind] = event.type.split(".");

  switch (event.type) {
    case "agent.tool_called": {
      const tool = str(p.tool, 60) ?? "";
      if (tool !== "search_providers" && tool !== "request_booking") return state;
      const window = obj(p.window);
      const ask: AskView = dropUndefined({
        tool,
        agentId: str(p.agent_id, 80),
        service: str(p.service, 120),
        location: str(p.location, 160),
        budgetCents: num(p.budget_cents),
        windowStart: str(window?.start ?? p.window_start, 40),
        windowEnd: str(window?.end ?? p.window_end, 40),
        // Only the customer's own words: the gateway's bookkeeping reason ("agent called ...") is not a quote.
        utterance: /^agent called\b/i.test(event.reason ?? "") ? undefined : str(event.reason, 300),
        at: event.created_at,
      });
      // A request_booking after a search keeps the richer search ask on screen.
      if (tool === "request_booking" && state.ask?.tool === "search_providers") return state;
      return { ...state, ask };
    }
    case "darwin.searched":
      return { ...state, darwin: readDarwin(event) };
    case "signals.computed": {
      const signals = obj(p.signals) ?? {};
      const entries = Object.entries(signals)
        .map(([k, v]): [string, string] | undefined => {
          const value = typeof v === "object" ? undefined : str(v, 80);
          return value === undefined ? undefined : [k, value];
        })
        .filter((e): e is [string, string] => e !== undefined)
        .slice(0, 6);
      return { ...state, signals: dropUndefined({ businessId: str(refs.business_id, 80), source: str(p.source, 40), note: str(p.note, 160), entries, at: event.created_at }) };
    }
    case "business.listed": {
      const id = str(refs.business_id, 80);
      if (!id) return state;
      const prev = state.businesses[id];
      // "created" again means a fresh run of the same seed: start the card over.
      const base = prev && p.change !== "created" ? prev : newBusiness(id);
      const business: BusinessView = dropUndefined({
        ...base,
        name: str(p.display_name, 80) ?? base.name,
        trade: str(p.trade, 40) ?? base.trade,
        channel: str(p.channel_state, 40) ?? base.channel,
      });
      return {
        ...state,
        businesses: { ...state.businesses, [id]: business },
        businessOrder: append(state.businessOrder, id),
      };
    }
    case "business.channel_changed":
      return updateBusiness(state, refs.business_id, (b) =>
        dropUndefined({ ...b, channel: str(p.to, 40) ?? b.channel, rail: str(p.rail, 20) ?? b.rail, channelChangedAt: event.created_at }),
      );
    case "business.text_number_set":
      return updateBusiness(state, refs.business_id, (b) => dropUndefined({ ...b, numberMasked: str(pick(p, "number_masked", "numberMasked"), 40) ?? b.numberMasked }));
    case "consent.recorded": {
      const consentId = str(refs.consent_id, 80) ?? event.id;
      return updateBusiness(state, refs.business_id, (b) =>
        dropUndefined({
          ...b,
          consentQuote: str(pick(p, "quoted_sentence", "quotedSentence"), 200) ?? b.consentQuote,
          consentSource: str(p.source, 40) ?? b.consentSource,
          consents: b.consents.some((c) => c.id === consentId) ? b.consents : [...b.consents, dropUndefined({ id: consentId, callId: str(refs.call_id, 80) })],
        }),
      );
    }
    case "call.placed": {
      const id = str(refs.call_id, 80) ?? str(p.dial_call_id, 80) ?? event.id;
      const call: CallView = dropUndefined({
        ...newCall(id, event),
        dialCallId: str(p.dial_call_id, 80),
        state: str(p.state, 30) ?? "Queued",
        scriptVersion: str(pick(p, "script_version", "scriptVersion"), 20) ?? "v1",
        maxSeconds: num(pick(p, "max_call_duration_seconds", "maxCallDurationSeconds")),
      });
      const withCall = { ...state, calls: { ...state.calls, [id]: call }, lastCallId: id };
      return call.businessId ? updateBusiness(withCall, call.businessId, (b) => ({ ...b, callIds: append(b.callIds, id) })) : withCall;
    }
    case "call.status_changed": {
      const to = str(p.to, 30);
      if (!to) return state;
      return updateCall(state, event, (c) =>
        dropUndefined({
          ...c,
          state: to,
          ringingAt: to === "Ringing" ? (c.ringingAt ?? event.created_at) : c.ringingAt,
          inProgressAt: to === "In-Progress" ? (c.inProgressAt ?? event.created_at) : c.inProgressAt,
          endedAt: to === "Terminated" ? (c.endedAt ?? event.created_at) : c.endedAt,
        }),
      );
    }
    case "call.ended":
      return updateCall(state, event, (c) =>
        dropUndefined({
          ...c,
          state: "Terminated",
          endedAt: c.endedAt ?? event.created_at,
          durationSeconds: num(pick(p, "duration_seconds", "durationSeconds")) ?? c.durationSeconds,
          endStatus: str(p.status, 40) ?? c.endStatus,
          canceled: bool(p.canceled) ?? c.canceled,
        }),
      );
    case "call.transcribed":
      return updateCall(state, event, (c) => ({ ...c, transcript: readTranscript(p) }));
    case "voice.tool_called": {
      const tool = str(p.tool, 60);
      if (!tool) return state;
      const ok = p.ok !== false;
      const output = obj(p.output);
      const error = ok ? undefined : (str(pick(p, "error", "message"), 200) ?? str(pick(output ?? {}, "error", "message", "code"), 200) ?? str(event.reason, 200));
      return updateCall(state, event, (c) => {
        if ((VOICE_TOOLS as readonly string[]).includes(tool)) {
          const slot: ToolSlot = dropUndefined({ state: ok ? "ok" : "failed", at: event.created_at, error });
          return { ...c, tools: { ...c.tools, [tool]: slot } };
        }
        return { ...c, otherTools: [...c.otherTools, { tool, ok, at: event.created_at }] };
      });
    }
    case "booking.slot_agreed": {
      const next = updateBooking(state, event, (b) => withBookingFacts(b, p));
      const price = num(p.price_cents);
      return price === undefined ? next : updateBusiness(next, refs.business_id, (b) => ({ ...b, lastPriceCents: price }));
    }
    case "hold.placed": {
      const bookingId = str(refs.booking_id, 80);
      if (!bookingId || !state.bookings[bookingId]) return state;
      // A held slot is shown until the booking carries its own agreed slot.
      return updateBooking(state, event, (b) => (b.slotStart ? b : dropUndefined({ ...b, slotStart: str(p.slot_start, 40), slotEnd: str(p.slot_end, 40) })));
    }
    case "reply.classified": {
      const messageId = str(refs.message_id, 80);
      const cls = str(p.class, 40);
      if (!messageId || !cls) return state;
      return {
        ...state,
        messages: state.messages.map((m) => (m.id === messageId ? { ...m, classification: dropUndefined({ class: cls, method: str(p.method, 40), confidence: event.confidence }) } : m)),
      };
    }
  }

  if (kind === "booking") return applyBookingTransition(state, event);
  if (kind === "message") return applyMessage(state, event);
  return state;
}

function withBookingFacts(b: BookingView, p: Obj): BookingView {
  return dropUndefined({
    ...b,
    shortCode: str(p.short_code, 20) ?? b.shortCode,
    slotStart: str(p.slot_start, 40) ?? b.slotStart,
    slotEnd: str(p.slot_end, 40) ?? b.slotEnd,
    priceCents: num(p.price_cents) ?? b.priceCents,
    fromTranscript: b.fromTranscript || p.source === "transcript",
  });
}

function applyBookingTransition(state: DashboardState, event: StreamEvent): DashboardState {
  const p = event.payload;
  const status = str(p.to, 30) ?? event.type.slice("booking.".length);
  // A creation event (no "from") starts the booking over, so a replayed run never inherits old evidence.
  const created = p.from === undefined && (status === "pending" || status === "quote_pending");
  let next = updateBooking(state, event, (existing) => {
    const b = created ? newBooking(existing.id, event) : existing;
    const evidence = obj(p.evidence);
    return dropUndefined({
      ...withBookingFacts(b, p),
      status,
      service: str(p.service, 120) ?? b.service,
      route: str(p.route, 20) ?? b.route,
      reasons: event.type === "booking.pending" ? strings(p.routing_reasons, 4) : b.reasons,
      confirmedAt: status === "confirmed" ? (b.confirmedAt ?? event.created_at) : b.confirmedAt,
      windowStart: str(p.window_start, 40) ?? b.windowStart,
      windowEnd: str(p.window_end, 40) ?? b.windowEnd,
      evidence: evidence
        ? dropUndefined({
            kind: str(evidence.kind, 20) ?? "unknown",
            quote: str(pick(evidence, "quotedSentence", "quoted_sentence"), 200),
            messageId: str(pick(evidence, "messageId", "message_id"), 80),
            callId: str(pick(evidence, "callId", "call_id"), 80),
          })
        : b.evidence,
    });
  });
  const bookingId = str(event.refs.booking_id, 80);
  if (event.type === "booking.pending" && bookingId) {
    next = { ...next, routing: dropUndefined({ bookingId, route: str(p.route, 20), shortCode: str(p.short_code, 20), reasons: strings(p.routing_reasons, 4), at: event.created_at }) };
  }
  const price = num(p.price_cents);
  if (price !== undefined) next = updateBusiness(next, event.refs.business_id, (b) => ({ ...b, lastPriceCents: price }));
  return next;
}

function applyMessage(state: DashboardState, event: StreamEvent): DashboardState {
  const p = event.payload;
  const id = str(event.refs.message_id, 80) ?? event.id;
  const verb = event.type.slice("message.".length);
  const existing = state.messages.find((m) => m.id === id);
  if (verb === "sent" || verb === "received") {
    if (existing) return state; // the same message replayed
    const body = str(p.body, 600);
    if (body === undefined) return state;
    const message: MessageView = dropUndefined({
      id,
      businessId: str(event.refs.business_id, 80),
      bookingId: str(event.refs.booking_id, 80),
      direction: verb === "sent" ? "out" : "in",
      body,
      channel: str(p.channel, 20),
      status: verb,
      at: event.created_at,
    });
    return { ...state, messages: [...state.messages, message] };
  }
  // message.delivered, message.failed, ...: a status update for a message already shown.
  if (!existing) return state;
  return { ...state, messages: state.messages.map((m) => (m.id === id ? { ...m, status: verb } : m)) };
}

function updateBusiness(state: DashboardState, rawId: unknown, fn: (b: BusinessView) => BusinessView): DashboardState {
  const id = str(rawId, 80);
  if (!id) return state;
  const prev = state.businesses[id] ?? newBusiness(id);
  return { ...state, businesses: { ...state.businesses, [id]: fn(prev) }, businessOrder: append(state.businessOrder, id) };
}

function updateCall(state: DashboardState, event: StreamEvent, fn: (c: CallView) => CallView): DashboardState {
  const id = str(event.refs.call_id, 80) ?? state.lastCallId;
  if (!id) return state;
  const prev = state.calls[id] ?? newCall(id, event);
  return { ...state, calls: { ...state.calls, [id]: fn(prev) }, lastCallId: state.lastCallId ?? id };
}

function updateBooking(state: DashboardState, event: StreamEvent, fn: (b: BookingView) => BookingView): DashboardState {
  const id = str(event.refs.booking_id, 80);
  if (!id) return state;
  const prev = state.bookings[id] ?? newBooking(id, event);
  const updated = { ...fn(prev), updatedAt: event.created_at };
  return { ...state, bookings: { ...state.bookings, [id]: updated }, bookingOrder: append(state.bookingOrder, id) };
}

// ---- Selectors ------------------------------------------------------------------------

export function currentCall(state: DashboardState): CallView | undefined {
  return state.lastCallId ? state.calls[state.lastCallId] : undefined;
}

/** The booking a call was placed for, if the events linked them. */
export function bookingForCall(state: DashboardState, call: CallView | undefined): BookingView | undefined {
  return call?.bookingId ? state.bookings[call.bookingId] : undefined;
}

/** The owner's reply that confirmed a booking by text, for "by text: Y". */
export function evidenceMessage(state: DashboardState, booking: BookingView): MessageView | undefined {
  const id = booking.evidence?.messageId;
  return id ? state.messages.find((m) => m.id === id) : undefined;
}

export interface SupplyRow {
  id: string;
  name: string;
  trade?: string;
  channel: string;
  rail?: string;
  medianReplySeconds?: number;
  replyCount: number;
  lastPriceCents?: number;
  /** One entry per script version that placed a call to this business. */
  optIn: { version: string; consents: number; calls: number; rate: number }[];
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Reply times for one business: each owner reply is paired with the most recent
 * outbound text before it that has not been answered yet.
 */
export function replySeconds(messages: readonly MessageView[]): number[] {
  const ordered = [...messages].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const out: number[] = [];
  let pending: number | undefined;
  for (const m of ordered) {
    const t = Date.parse(m.at);
    if (Number.isNaN(t)) continue;
    if (m.direction === "out") pending = t;
    else if (pending !== undefined) {
      out.push(Math.max(0, (t - pending) / 1000));
      pending = undefined;
    }
  }
  return out;
}

/** The supply table, computed in the browser from the stream (there is no shared signals function). */
export function supplyRows(state: DashboardState): SupplyRow[] {
  return state.businessOrder.map((id) => {
    const b = state.businesses[id]!;
    const replies = replySeconds(state.messages.filter((m) => m.businessId === id));
    const byVersion = new Map<string, { calls: Set<string>; consents: number }>();
    for (const callId of b.callIds) {
      const version = state.calls[callId]?.scriptVersion ?? "v1";
      const entry = byVersion.get(version) ?? { calls: new Set<string>(), consents: 0 };
      entry.calls.add(callId);
      byVersion.set(version, entry);
    }
    // A consent counts toward the script version of the call it was given on;
    // without a call ref it is credited to the business's latest call.
    for (const consent of b.consents) {
      const callId = consent.callId ?? b.callIds.at(-1);
      const version = (callId && state.calls[callId]?.scriptVersion) || "v1";
      const entry = byVersion.get(version) ?? { calls: new Set<string>(), consents: 0 };
      entry.consents += 1;
      byVersion.set(version, entry);
    }
    const optIn = [...byVersion.entries()].map(([version, v]) => {
      const consents = Math.min(v.consents, v.calls.size);
      return { version, consents, calls: v.calls.size, rate: v.calls.size ? consents / v.calls.size : 0 };
    });
    return dropUndefined({
      id,
      name: b.name,
      trade: b.trade,
      channel: b.channel,
      rail: b.rail,
      medianReplySeconds: median(replies),
      replyCount: replies.length,
      lastPriceCents: b.lastPriceCents,
      optIn,
    });
  });
}

/** The booking the most recent call was placed for, and the most recent booking routed by text. */
export function storyBookings(state: DashboardState): { byCall?: BookingView; byText?: BookingView } {
  const ordered = state.bookingOrder.map((id) => state.bookings[id]!);
  const byCall = bookingForCall(state, currentCall(state)) ?? ordered.filter((b) => b.route === "call").at(-1);
  const byText = ordered.filter((b) => b.route === "text").at(-1);
  return dropUndefined({ byCall, byText });
}

/** Seconds from the first text about a booking to its confirmation: the "confirmed in 4 s" figure. */
export function confirmSeconds(state: DashboardState, booking: BookingView): number | undefined {
  if (!booking.confirmedAt) return undefined;
  const first = state.messages.find((m) => m.bookingId === booking.id && m.direction === "out");
  if (!first) return undefined;
  const seconds = (Date.parse(booking.confirmedAt) - Date.parse(first.at)) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

const OPEN_STATUSES = new Set(["quote_pending", "quoted", "pending", "countered"]);

/**
 * The text the owner has not answered yet, if a booking is still waiting on them:
 * the latest outbound message whose booking is open and that no owner reply follows.
 * The owner-reply buttons on /live show only while this returns something.
 */
export function awaitingOwner(state: DashboardState): MessageView | undefined {
  const last = state.messages.at(-1);
  if (!last || last.direction !== "out") return undefined;
  const booking = last.bookingId ? state.bookings[last.bookingId] : undefined;
  if (!booking || !OPEN_STATUSES.has(booking.status)) return undefined;
  return last;
}
