import { systemClock, type Clock } from "../clock";
import type { DIAL_CALL_STATES} from "../contracts/index";
import { type DialCall, type DialEvent, type PlaceCallRequest, type VoiceTools } from "../contracts/index";
import { getBusinessByNumber, getCallByDialId, insertRow, updateRow, type Db } from "../db/repo";
import type { TranscriptTurn } from "../db/types";
import type { EventBus } from "../events/bus";
import { emit } from "../events/log";
import { newId } from "../ids";
import { assertAllowedNumber } from "../safety";
import { GOLDEN_CALL_END_MS, goldenCallScript, type CallScriptStep, type ScriptState } from "./call-script";

type DialCallState = (typeof DIAL_CALL_STATES)[number];

/** Read through a function so TypeScript does not narrow away state changed by timers. */
const isTerminated = (call: DialCall): boolean => call.status.state === "Terminated";

export interface FakeDialOptions {
  /** Non-negotiable 6 applies to the fake too: it refuses numbers outside this list. */
  allowedNumbers: readonly string[];
  /** Our Dial number (the caller id). */
  fromNumber?: string;
  /** When set, the scripted voice agent calls these tools mid-call, as Dial's Context MCP would. */
  voiceTools?: VoiceTools;
  /** When set, FakeDial keeps the calls table and emits call.* events (the real voice package does this in live mode). */
  db?: Db;
  bus?: Pick<EventBus, "publish">;
  clock?: Clock;
  /** 1 = real time; 0.01 = a 49-second call in half a second; 0 = no waiting (a ManualClock is advanced instead). */
  timeScale?: number;
  /** Numbers that are themselves Dial numbers; the only ones that may receive channel "sms". */
  dialNumbers?: readonly string[];
  /** Reply this body to every outbound message after `afterMs` (the owner tapping Y). */
  autoReply?: { body: string; afterMs: number };
  script?: (state: ScriptState, now: Date) => CallScriptStep[];
}

export interface FakeMessage {
  id: string;
  from: string;
  to: string;
  channel: "sms" | "imessage" | "whatsapp";
  body: string;
  direction: "outbound" | "inbound";
  createdAt: string;
}

/**
 * Dial, faked. Same request and event shapes as api.getdial.ai (see contracts/dial.ts).
 * Plays the golden-path call on a timer: status changes, mid-call tool calls,
 * exactly one call.ended, then call.transcribed with realistic transcriptTurns.
 */
export class FakeDial {
  private readonly listeners = new Set<(event: DialEvent) => void>();
  private readonly calls = new Map<string, DialCall>();
  private readonly running = new Map<string, Promise<void>>();
  readonly messages: FakeMessage[] = [];
  readonly toolErrors: { tool: string; message: string }[] = [];
  private seq = 0;

  constructor(private readonly options: FakeDialOptions) {}

  private get clock(): Clock {
    return this.options.clock ?? systemClock;
  }

  on(listener: (event: DialEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}_fake${String(this.seq).padStart(4, "0")}`;
  }

  private async sleep(ms: number): Promise<void> {
    const scale = this.options.timeScale ?? 1;
    const clock = this.clock as Clock & { advance?: (ms: number) => void };
    if (scale === 0 && clock.advance) {
      clock.advance(ms);
      return;
    }
    await new Promise((r) => setTimeout(r, ms * scale));
  }

  private dispatch(event: DialEvent): void {
    for (const l of this.listeners) l(event);
  }

  private envelope<T extends DialEvent["type"]>(type: T, related: { id: string; type: "call" | "message" }, data: Extract<DialEvent, { type: T }>["data"]) {
    return {
      id: this.id("evt"),
      object: "event" as const,
      type,
      version: 1,
      createdAt: this.clock.now().toISOString(),
      relatedObject: { id: related.id, type: related.type, url: related.type === "call" ? `/api/v1/calls/${related.id}` : null },
      data,
    } as Extract<DialEvent, { type: T }>;
  }

  private pub(input: Parameters<typeof emit>[1]): void {
    if (!this.options.db) return;
    emit(this.options.db, input, { ...(this.options.bus ? { bus: this.options.bus } : {}), clock: this.clock });
  }

  /** POST /api/v1/calls. Refuses numbers outside ALLOWED_NUMBERS and a second live call to the same number. */
  async placeCall(request: PlaceCallRequest, link: { business_id?: string; booking_id?: string } = {}): Promise<{ call: DialCall }> {
    assertAllowedNumber(request.to, this.options.allowedNumbers);
    const live = [...this.calls.values()].find((c) => c.to === request.to && c.status.state !== "Terminated");
    if (live) throw new Error("A call to this number is already live; never place a second one");
    const now = this.clock.now().toISOString();
    const call: DialCall = {
      id: this.id("call"),
      phoneNumberId: request.fromNumberId,
      from: this.options.fromNumber ?? "+15550100000",
      to: request.to,
      direction: "outbound",
      status: { state: "Queued", terminationType: null, label: "Queued" },
      duration: 0,
      transcript: null,
      transcriptTurns: null,
      createdAt: now,
    };
    this.calls.set(call.id, call);

    const db = this.options.db;
    let businessId = link.business_id;
    if (db) {
      businessId ??= getBusinessByNumber(db, request.to)?.id;
      if (!businessId) throw new Error("FakeDial: no business for this number");
      const row = insertRow(db, "calls", {
        id: newId("call", this.clock.now().getTime()),
        business_id: businessId,
        booking_id: link.booking_id ?? null,
        dial_call_id: call.id,
        direction: "outbound",
        to_e164: request.to,
        status: "Queued",
        script_version: "golden-v1",
        started_at: null,
        ended_at: null,
        duration_seconds: null,
        end_reason: null,
        transcript: null,
        transcript_turns: null,
        mined: null,
        friction_score: null,
        created_at: now,
        updated_at: now,
      });
      this.pub({
        type: "call.placed",
        actor: "system",
        refs: { call_id: row.id, business_id: businessId, ...(link.booking_id ? { booking_id: link.booking_id } : {}) },
        payload: { dial_call_id: call.id, max_call_duration_seconds: request.maxCallDurationSeconds ?? null, state: "Queued" },
        reason: "outbound call queued",
      });
    }
    const state: ScriptState = { business_id: businessId ?? "", called_number: request.to, ...(link.booking_id ? { booking_id: link.booking_id } : {}) };
    const script = (this.options.script ?? ((_s, n) => goldenCallScript({ now: n })))(state, this.clock.now());
    this.running.set(call.id, this.play(call, script, state));
    return { call: structuredClone(call) };
  }

  /** Resolves when every scripted call has finished. */
  async settle(): Promise<void> {
    await Promise.all(this.running.values());
  }

  private setState(call: DialCall, next: DialCallState, terminationType: DialCall["status"]["terminationType"] = null): void {
    const previous = call.status.state;
    call.status = { state: next, terminationType, label: next };
    this.dispatch(
      this.envelope("call.status_changed", { id: call.id, type: "call" }, {
        callId: call.id,
        direction: "outbound",
        from: call.from,
        to: call.to,
        status: { state: next, label: next },
        previousState: previous,
        terminationType,
      }),
    );
    const db = this.options.db;
    if (db) {
      const row = getCallByDialId(db, call.id)!;
      const now = this.clock.now().toISOString();
      updateRow(db, "calls", row.id, { status: next, updated_at: now, ...(next === "In-Progress" ? { started_at: now } : {}) });
      this.pub({ type: "call.status_changed", actor: "system", refs: { call_id: row.id, business_id: row.business_id, ...(row.booking_id ? { booking_id: row.booking_id } : {}) }, payload: { from: previous, to: next }, reason: "Dial status update" });
    }
  }

  private async play(call: DialCall, script: CallScriptStep[], state: ScriptState): Promise<void> {
    await this.sleep(1_500);
    this.setState(call, "Ringing");
    await this.sleep(4_000);
    if (isTerminated(call)) return;
    this.setState(call, "In-Progress");
    const turns: TranscriptTurn[] = [];
    let elapsed = 0;
    for (const step of script) {
      if (isTerminated(call)) break;
      await this.sleep(Math.max(0, step.atMs - elapsed));
      elapsed = Math.max(elapsed, step.atMs);
      if (step.kind === "turn") {
        turns.push({ speaker: step.speaker, text: step.text, startMs: step.atMs, endMs: step.atMs + step.durationMs });
      } else if (this.options.voiceTools) {
        try {
          const output = await this.options.voiceTools[step.tool](step.input(state) as never, {
            caller_number: call.to,
            direction: "outbound",
            agent_number: call.from,
          });
          step.save?.(output as never, state);
        } catch (error) {
          this.toolErrors.push({ tool: step.tool, message: (error as Error).message });
        }
      }
    }
    await this.sleep(Math.max(0, GOLDEN_CALL_END_MS - elapsed));
    if (!isTerminated(call)) this.finish(call, turns, "completed", false);
  }

  private finish(call: DialCall, turns: TranscriptTurn[], status: "completed" | "canceled", canceled: boolean): void {
    const durationSeconds = Math.round((turns.at(-1)?.endMs ?? 0) / 1000) + 3;
    this.setState(call, "Terminated", status);
    call.duration = durationSeconds;
    call.transcriptTurns = canceled ? null : turns;
    call.transcript = canceled ? null : turns.map((t) => `${t.speaker === "agent" ? "Agent" : "User"}: ${t.text}`).join("\n");
    this.dispatch(
      this.envelope("call.ended", { id: call.id, type: "call" }, {
        callId: call.id,
        from: call.from,
        to: call.to,
        direction: "outbound",
        durationSeconds,
        status,
        canceled,
        transcriptAvailable: !canceled,
      }),
    );
    const db = this.options.db;
    const row = db ? getCallByDialId(db, call.id) : undefined;
    if (db && row) {
      const now = this.clock.now().toISOString();
      updateRow(db, "calls", row.id, { ended_at: now, duration_seconds: durationSeconds, end_reason: status, updated_at: now });
      this.pub({ type: "call.ended", actor: "system", refs: { call_id: row.id, business_id: row.business_id, ...(row.booking_id ? { booking_id: row.booking_id } : {}) }, payload: { duration_seconds: durationSeconds, status, canceled }, reason: "Dial reported the call ended" });
    }
    if (canceled) return;
    this.dispatch(this.envelope("call.transcribed", { id: call.id, type: "call" }, { callId: call.id }));
    if (db && row) {
      updateRow(db, "calls", row.id, { transcript: call.transcript, transcript_turns: turns, updated_at: this.clock.now().toISOString() });
      this.pub({ type: "call.transcribed", actor: "system", refs: { call_id: row.id, business_id: row.business_id, ...(row.booking_id ? { booking_id: row.booking_id } : {}) }, payload: { turns }, reason: "transcript available" });
    }
  }

  /** POST /api/v1/calls/{id}/stop (the kill switch). */
  stopCall(id: string): DialCall {
    const call = this.calls.get(id);
    if (!call) throw new Error("Call not found");
    if (call.status.state === "Terminated") throw new Error("Call already ended");
    this.finish(call, [], "canceled", true);
    return structuredClone(call);
  }

  /** GET /api/v1/calls, newest first. Check this before any second attempt (non-negotiable 4). */
  listCalls(): { calls: DialCall[] } {
    return { calls: [...this.calls.values()].reverse().map((c) => structuredClone(c)) };
  }

  getCall(id: string): { call: DialCall } {
    const call = this.calls.get(id);
    if (!call) throw new Error("Call not found");
    return { call: structuredClone(call) };
  }

  /** POST /api/v1/messages. Refuses numbers outside ALLOWED_NUMBERS and sms to a non-Dial number. */
  async sendMessage(request: { to: string; body: string; channel: "sms" | "imessage" | "whatsapp" }): Promise<{ message: FakeMessage }> {
    assertAllowedNumber(request.to, this.options.allowedNumbers);
    if (request.channel === "sms" && !(this.options.dialNumbers ?? []).includes(request.to)) {
      throw new Error("SMS to a non-Dial number needs 10DLC; use imessage, whatsapp or a Dial-to-Dial number");
    }
    const message: FakeMessage = {
      id: this.id("msg"),
      from: this.options.fromNumber ?? "+15550100000",
      to: request.to,
      channel: request.channel,
      body: request.body,
      direction: "outbound",
      createdAt: this.clock.now().toISOString(),
    };
    this.messages.push(message);
    if (this.options.autoReply) {
      const { body, afterMs } = this.options.autoReply;
      this.running.set(
        message.id,
        new Promise<void>((r) => setImmediate(r))
          .then(() => this.sleep(afterMs))
          .then(() => {
          this.receive({ from: request.to, body, channel: request.channel });
        }),
      );
    }
    return { message: structuredClone(message) };
  }

  /** Simulates the owner texting us (message.received). */
  receive({ from, body, channel = "imessage" }: { from: string; body: string; channel?: FakeMessage["channel"] }): FakeMessage {
    const message: FakeMessage = { id: this.id("msg"), from, to: this.options.fromNumber ?? "+15550100000", channel, body, direction: "inbound", createdAt: this.clock.now().toISOString() };
    this.messages.push(message);
    this.dispatch(
      this.envelope("message.received", { id: message.id, type: "message" }, { messageId: message.id, from, to: message.to, channel, body, media: [], source: "external" }),
    );
    return message;
  }
}
