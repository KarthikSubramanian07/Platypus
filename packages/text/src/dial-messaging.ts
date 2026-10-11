import { maskNumber } from "@platypus/shared/config";
import { assertAllowedNumber } from "@platypus/shared/safety";
import type { FakeDial } from "@platypus/shared/testing";

/**
 * Dial messaging, and only messaging (the voice package owns calls).
 * Checked against docs.getdial.ai/openapi.json on 2026-10-11:
 *  - POST /messages {to, channel?, fromNumberId | fromNumber, body} -> 201 {message}. NOT idempotent.
 *  - GET /messages?contact=&direction=&since= -> {messages}, newest first. Check this before any resend.
 *  - GET /lookup?number= -> {number, supports: {imessage, whatsapp}}. 502 and 429 say nothing about the number.
 */

export type DialSendChannel = "sms" | "imessage" | "whatsapp";

export interface DialMessageRecord {
  id: string;
  from: string;
  to: string | null;
  body: string;
  direction: "inbound" | "outbound";
  channel: string;
  createdAt: string;
}

export interface ListMessagesQuery {
  contact?: string;
  direction?: "inbound" | "outbound";
  /** ISO-8601; only messages created after it. */
  since?: string;
}

export interface NumberSupports {
  imessage: boolean;
  whatsapp: boolean;
}

export interface DialMessaging {
  sendMessage(input: { to: string; body: string; channel: DialSendChannel }): Promise<{ id: string; from?: string }>;
  listMessages(query: ListMessagesQuery): Promise<DialMessageRecord[]>;
  lookup(number: string): Promise<NumberSupports>;
}

/** Dial answered with an error status. The request had no effect (4xx) or its effect is unknown (5xx on a send). */
export class DialApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "DialApiError";
  }
}

/** A send whose outcome we cannot know (network failure, timeout, 5xx). Never retry it blind: list messages first. */
export class SendOutcomeUnknownError extends Error {
  constructor(cause: string) {
    super(`The message may or may not have been sent (${cause}); check GET /messages before any resend`);
    this.name = "SendOutcomeUnknownError";
  }
}

/** Lookup could not reach a verdict (502) or was rate-limited (429). Ask again later; never read it as false. */
export class LookupUnavailableError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfterMs: number | null,
  ) {
    super(`Number lookup unavailable (HTTP ${status}); try again${retryAfterMs ? ` in ${Math.ceil(retryAfterMs / 1000)}s` : ""}`);
    this.name = "LookupUnavailableError";
  }
}

/** Non-negotiable 8: "sms" only to a number that is itself on Dial (Dial-to-Dial); everything else needs 10DLC. */
export class SmsNotAllowedError extends Error {
  constructor(number: string) {
    super(`Refusing sms to ${maskNumber(number)}: it is not a Dial number, and SMS to other numbers needs 10DLC`);
    this.name = "SmsNotAllowedError";
  }
}

/** The send rules every DialMessaging enforces immediately before the network request. */
export function assertSendable(to: string, channel: DialSendChannel, rules: { allowedNumbers: readonly string[]; dialNumbers: readonly string[] }): void {
  assertAllowedNumber(to, rules.allowedNumbers);
  if (channel === "sms" && !rules.dialNumbers.includes(to)) throw new SmsNotAllowedError(to);
}

export interface DialMessagingOptions {
  apiKey: string;
  /** DIAL_FROM_NUMBER_ID (preferred) or a number/nickname for `fromNumber`. Exactly one is sent. */
  fromNumberId?: string;
  fromNumber?: string;
  allowedNumbers: readonly string[];
  /** Numbers that are themselves Dial numbers (DIAL_OWNER_NUMBERS): the only ones that may receive "sms". */
  dialNumbers?: readonly string[];
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export const DIAL_API_BASE = "https://api.getdial.ai/api/v1";

function retryAfter(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const seconds = Number(h);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } | string; message?: string };
    if (typeof body.error === "string") return body.error;
    return body.error?.message ?? body.message ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

/** The real client over fetch. */
export function createDialMessaging(options: DialMessagingOptions): DialMessaging {
  if (Boolean(options.fromNumberId) === Boolean(options.fromNumber)) {
    throw new Error("Provide exactly one of fromNumberId or fromNumber");
  }
  const base = (options.baseUrl ?? DIAL_API_BASE).replace(/\/$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  const headers = { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json", Accept: "application/json" };
  const rules = { allowedNumbers: options.allowedNumbers, dialNumbers: options.dialNumbers ?? [] };
  const timeout = () => AbortSignal.timeout(options.timeoutMs ?? 20_000);

  return {
    async sendMessage({ to, body, channel }) {
      assertSendable(to, channel, rules);
      let res: Response;
      try {
        res = await doFetch(`${base}/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify({ to, channel, body, ...(options.fromNumberId ? { fromNumberId: options.fromNumberId } : { fromNumber: options.fromNumber }) }),
          signal: timeout(),
        });
      } catch (error) {
        throw new SendOutcomeUnknownError((error as Error).name);
      }
      if (res.status >= 500) throw new SendOutcomeUnknownError(`HTTP ${res.status}`);
      if (!res.ok) throw new DialApiError(res.status, `POST /messages failed: ${await errorText(res)}`, retryAfter(res));
      const json = (await res.json()) as { message?: { id?: string; from?: string } };
      if (!json.message?.id) throw new SendOutcomeUnknownError("201 without a message id");
      return { id: json.message.id, ...(json.message.from ? { from: json.message.from } : {}) };
    },

    async listMessages(query) {
      const params = new URLSearchParams();
      if (query.contact) params.set("contact", query.contact);
      if (query.direction) params.set("direction", query.direction);
      if (query.since) params.set("since", query.since);
      const res = await doFetch(`${base}/messages?${params}`, { headers, signal: timeout() });
      if (!res.ok) throw new DialApiError(res.status, `GET /messages failed: ${await errorText(res)}`, retryAfter(res));
      const json = (await res.json()) as { messages?: DialMessageRecord[] };
      return json.messages ?? [];
    },

    async lookup(number) {
      const res = await doFetch(`${base}/lookup?number=${encodeURIComponent(number)}`, { headers, signal: timeout() });
      if (res.status === 502 || res.status === 429 || res.status === 503) throw new LookupUnavailableError(res.status, retryAfter(res));
      if (!res.ok) throw new DialApiError(res.status, `GET /lookup failed: ${await errorText(res)}`, retryAfter(res));
      const json = (await res.json()) as { supports?: Partial<NumberSupports> };
      return { imessage: json.supports?.imessage === true, whatsapp: json.supports?.whatsapp === true };
    },
  };
}

export interface FakeDialMessagingOptions {
  /** What lookup answers per number; default: iMessage yes, WhatsApp no. A function may throw LookupUnavailableError. */
  lookup?: Record<string, NumberSupports> | ((number: string) => NumberSupports);
}

/**
 * DialMessaging over the shared FakeDial, for tests and DEMO_MODE=fakes. FakeDial
 * enforces ALLOWED_NUMBERS and the sms rule itself, the same as production.
 */
export function createFakeDialMessaging(fake: FakeDial, options: FakeDialMessagingOptions = {}): DialMessaging & { lookups: string[] } {
  const lookups: string[] = [];
  return {
    lookups,
    async sendMessage({ to, body, channel }) {
      const { message } = await fake.sendMessage({ to, body, channel });
      return { id: message.id, from: message.from };
    },
    async listMessages(query) {
      return fake.messages
        .filter((m) => (!query.direction || m.direction === query.direction) && (!query.contact || m.to === query.contact || m.from === query.contact))
        .filter((m) => !query.since || m.createdAt > query.since)
        .reverse()
        .map((m) => ({ id: m.id, from: m.from, to: m.to, body: m.body, direction: m.direction, channel: m.channel, createdAt: m.createdAt }));
    },
    async lookup(number) {
      lookups.push(number);
      const l = options.lookup;
      if (typeof l === "function") return l(number);
      return l?.[number] ?? { imessage: true, whatsapp: false };
    },
  };
}
