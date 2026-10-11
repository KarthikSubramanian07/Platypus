/**
 * Deterministic transcript mining: spoken numbers, prices, times, lead times,
 * hours, yes/no, do-not-call, voicemail and friction, with no model and no key.
 * Everything here is a regex or arithmetic so it is fast, free and testable; the
 * optional Claude pass (claude.ts) only adds what these miss.
 */

const UNITS: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const unit = (t: string | undefined): number | undefined => (t !== undefined && Object.hasOwn(UNITS, t) ? UNITS[t] : undefined);
const ten = (t: string | undefined): number | undefined => (t !== undefined && Object.hasOwn(TENS, t) ? TENS[t] : undefined);

const WORDS = [...Object.keys(UNITS), ...Object.keys(TENS), "hundred"];
const NUM_WORD = new RegExp(`\\b(?:${[...WORDS, "a", "and"].join("|")})(?:[\\s-]+(?:${[...WORDS, "and"].join("|")}))*\\b`, "gi");

/** "eighty-nine" -> 89, "a hundred and twenty" -> 120, "one twenty" -> 120 (price shorthand), "ninety nine" -> 99. */
export function wordsToNumber(s: string, { hundredsShorthand = true }: { hundredsShorthand?: boolean } = {}): number | null {
  const toks = s.toLowerCase().replace(/-/g, " ").split(/\s+/).filter((t) => t && t !== "and");
  if (!toks.length) return null;
  if (toks.length === 1 && toks[0] === "a") return null;
  // "one twenty", "two fifty": a unit then a tens group is hundreds shorthand when talking money.
  const first = unit(toks[0]);
  if (hundredsShorthand && toks.length >= 2 && first !== undefined && first > 0 && first < 10 && (ten(toks[1]) !== undefined || (unit(toks[1]) ?? 0) >= 10)) {
    const rest = wordsToNumber(toks.slice(1).join(" "));
    if (rest !== null && rest < 100) return first * 100 + rest;
  }
  let cur = 0;
  let seen = false;
  for (const t of toks) {
    if (t === "a") {
      cur = cur || 1;
      continue;
    }
    const u = unit(t);
    const tn = ten(t);
    if (u !== undefined) cur += u;
    else if (tn !== undefined) cur += tn;
    else if (t === "hundred") cur = (cur || 1) * 100;
    else return null;
    seen = true;
  }
  return seen ? cur : null;
}

/** Replaces spelled-out numbers with digits so one set of patterns handles both. */
export function normalizeNumbers(text: string, opts: { hundredsShorthand?: boolean } = {}): string {
  return text.replace(NUM_WORD, (m) => {
    // In times, "two thirty" is 2:30, not 230.
    if (opts.hundredsShorthand === false) {
      const parts = m.toLowerCase().replace(/-/g, " ").split(/\s+/);
      const head = unit(parts[0]);
      const rest = parts.length > 1 ? wordsToNumber(parts.slice(1).join(" "), { hundredsShorthand: false }) : null;
      if (head !== undefined && head >= 1 && head <= 12 && rest !== null && rest >= 10 && rest <= 59) return `${head}:${String(rest).padStart(2, "0")}`;
    }
    const n = wordsToNumber(m, opts);
    return n === null ? m : String(n);
  });
}

export interface PriceMatch {
  cents: number;
  approximate: boolean;
  text: string;
}

const PRICE_RE = /(?:\$\s?(\d{1,4}(?:\.\d{2})?)|\b(\d{1,4}(?:\.\d{2})?)\s*(?:bucks|dollars?|usd)\b)/gi;

export function findPrices(raw: string): PriceMatch[] {
  const t = normalizeNumbers(raw);
  const out: PriceMatch[] = [];
  for (const m of t.matchAll(PRICE_RE)) {
    const v = parseFloat((m[1] ?? m[2])!);
    const pre = t.slice(Math.max(0, m.index - 12), m.index).toLowerCase();
    out.push({ cents: Math.round(v * 100), approximate: /about|around|roughly|like|maybe|starts? at|from/.test(pre), text: m[0] });
  }
  return out;
}

export interface TimeMatch {
  hour24: number;
  minute: number;
  /** False when am/pm was inferred rather than said. */
  explicit: boolean;
  text: string;
}

const TIME_RE = /\b(noon|midday|(\d{1,2})(?::(\d{2}))?\s*(o'?\s?clock|a\.?m\.?|p\.?m\.?)?(?:\s*(?:in the )?(morning|afternoon|evening))?)\b/gi;

/** Times as 24-hour clock. Bare hours 1-6 default to pm (owners mean the afternoon), 7-11 to am. */
export function findTimes(raw: string, { defaultMeridiem = "pm" }: { defaultMeridiem?: "am" | "pm" } = {}): TimeMatch[] {
  const t = normalizeNumbers(raw, { hundredsShorthand: false })
    .replace(/\bhalf past (\d{1,2})\b/gi, "$1:30")
    .replace(/\bquarter past (\d{1,2})\b/gi, "$1:15")
    .replace(/\b(\d{1,2}) (15|30|45)\b/g, "$1:$2");
  const out: TimeMatch[] = [];
  for (const m of t.matchAll(TIME_RE)) {
    if (/noon|midday/i.test(m[1]!)) {
      out.push({ hour24: 12, minute: 0, explicit: true, text: m[0] });
      continue;
    }
    const h = parseInt(m[2]!, 10);
    const min = m[3] ? parseInt(m[3], 10) : 0;
    const suffix = (m[4] ?? "").toLowerCase();
    const part = (m[5] ?? "").toLowerCase();
    if (!(suffix || m[3] || part)) continue; // a bare "2" is not a time
    if (h < 1 || h > 12 || min > 59) continue;
    let pm: boolean;
    let explicit = true;
    if (suffix.startsWith("p") || part === "afternoon" || part === "evening") pm = true;
    else if (suffix.startsWith("a") || part === "morning") pm = false;
    else {
      explicit = false;
      pm = defaultMeridiem === "pm" ? h <= 6 || h === 12 : h === 12;
    }
    const hour24 = h === 12 ? (pm ? 12 : 0) : pm ? h + 12 : h;
    out.push({ hour24, minute: min, explicit, text: m[0].trim() });
  }
  return out;
}

const DUR_RE = /\b(\d{1,3}|an?|half an?)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)\b/gi;

export function findLeadTimes(raw: string): { minutes: number; text: string }[] {
  const t = normalizeNumbers(raw);
  const out: { minutes: number; text: string }[] = [];
  for (const m of t.matchAll(DUR_RE)) {
    const q = /half/i.test(m[1]!) ? 0.5 : /^an?$/i.test(m[1]!) ? 1 : parseInt(m[1]!, 10);
    const u = m[2]!.toLowerCase();
    const mult = u.startsWith("m") ? 1 : u.startsWith("h") ? 60 : u.startsWith("d") ? 1440 : 10080;
    out.push({ minutes: q * mult, text: m[0] });
  }
  if (/\bsame[- ]day\b/i.test(raw)) out.push({ minutes: 0, text: "same day" });
  return out;
}

const DAY = "(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*";

export function findHours(raw: string): { kind: "open_range" | "closes" | "days" | "closed_days"; text: string }[] {
  const t = normalizeNumbers(raw);
  const out: { kind: "open_range" | "closes" | "days" | "closed_days"; text: string }[] = [];
  const range = t.match(/\bopen(?:\s+from)?\s+(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)\s*(?:to|till|until|-)\s*(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)/i);
  if (range) out.push({ kind: "open_range", text: range[0] });
  const close = t.match(/\bclose[sd]?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)/i);
  if (close) out.push({ kind: "closes", text: close[0] });
  const days = t.match(new RegExp(`\\b${DAY}\\s*(?:through|thru|to|-)\\s*${DAY}`, "i"));
  if (days) out.push({ kind: "days", text: days[0] });
  const closed = t.match(/\bclosed (on )?(sundays?|saturdays?|weekends?)\b/i);
  if (closed) out.push({ kind: "closed_days", text: closed[0] });
  return out;
}

export const YES_RE = /^\s*(yeah|yes|yep|yup|sure|ok(ay)?|absolutely|definitely|of course|go ahead|please do|that works|fine|sounds good|text (me|is fine|works)|you can)\b/i;
export const NO_RE = /^\s*(no|nah|nope|not really|rather not|i'?d rather|don'?t|please don'?t|just call)\b/i;
export const DNC_RE = /\b(don'?t|do not|stop|quit|never)\s+(call|calling|ring)(ing)?\b|\btake (me|us|this number) off\b|\bremove (me|us|this number)\b|\bdo not call list\b|\bno more calls\b/i;
export const WRONG_RE = /\bwrong number\b|\b(this is|it'?s) not\b|\bno,? this is\b|\bnever heard of\b/i;
export const VOICEMAIL_RE = /\b(leave (a|your) message|after the (tone|beep)|not available|voicemail|mailbox (is )?full|record your message)\b/i;
export const AI_Q_RE = /\b(are you (a )?(robot|bot|real|human|person|computer|ai|machine)|is this (a )?(robot|recording|bot|real person|ai)|am i talking to)\b/i;
export const CLARIFY_RE = /^\s*(sorry|what|huh|pardon|come again|say (that )?again|can you repeat)\b/i;
export const THIS_LINE_RE = /\b(this (one|number|line|phone)|same number|the one you('re| are)? call(ed|ing)|this is (my|a) cell|you'?ve got it)\b/i;

export function findOwnerName(turnText: string): string | null {
  const m = turnText.match(/\b(?:this is|it'?s|i'?m|my name is|speaking,?)\s+([A-Z][a-z]{1,20})\b/);
  if (!m) return null;
  if (/^(Sal|Auto|The|Not|Just|Here)$/.test(m[1]!)) return null;
  return m[1]!;
}

const DIGIT: Record<string, string> = { zero: "0", oh: "0", o: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };

/** "four one five, five five five, oh one two three" -> +14155550123. US numbers only. */
export function findSpokenPhone(raw: string): string | null {
  const toks = raw.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/);
  let digits = "";
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    const next = toks[i + 1];
    if (/^\d+$/.test(t)) digits += t;
    else if (Object.hasOwn(DIGIT, t)) digits += DIGIT[t];
    else if ((t === "double" || t === "triple") && next !== undefined && Object.hasOwn(DIGIT, next)) {
      digits += DIGIT[next]!.repeat(t === "double" ? 2 : 3);
      i++;
    }
  }
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.length === 10 ? `+1${digits}` : null;
}

export interface TimedTurn {
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
}

export interface Friction {
  /** startMs minus the previous turn's endMs, at every change of speaker (negative = talking over). */
  pauses: number[];
  maxPauseMs: number | null;
  /** How long the owner took to answer each agent turn. */
  owner_reply_latency_ms: number[];
  median_owner_reply_ms: number | null;
  max_owner_reply_ms: number | null;
  overlaps: number;
  clarification_requests: number;
  agent_talk_ms: number;
  owner_talk_ms: number;
  duration_ms: number;
  /**
   * 0 (smooth) to 1 (rough): 0.4 x slow replies (median vs 2.5s) + 0.3 x talking
   * over each other (vs 3) + 0.3 x "sorry, what?" (vs 2).
   */
  score: number;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export function friction(turns: readonly TimedTurn[]): Friction {
  const pauses: number[] = [];
  const gaps: number[] = [];
  let overlaps = 0;
  for (let i = 1; i < turns.length; i++) {
    const a = turns[i - 1]!;
    const b = turns[i]!;
    if (a.speaker === b.speaker) continue;
    const gap = b.startMs - a.endMs;
    pauses.push(gap);
    if (gap < 0) overlaps++;
    if (a.speaker === "agent" && b.speaker === "user") gaps.push(Math.max(0, gap));
  }
  const sorted = [...gaps].sort((x, y) => x - y);
  const talk = (s: string) => turns.filter((t) => t.speaker === s).reduce((n, t) => n + (t.endMs - t.startMs), 0);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null;
  const clarifications = turns.filter((t) => t.speaker === "user" && CLARIFY_RE.test(t.text)).length;
  const score = clamp01(0.4 * Math.min(1, (median ?? 0) / 2500) + 0.3 * Math.min(1, overlaps / 3) + 0.3 * Math.min(1, clarifications / 2));
  return {
    pauses,
    maxPauseMs: pauses.length ? Math.max(...pauses) : null,
    owner_reply_latency_ms: gaps,
    median_owner_reply_ms: median,
    max_owner_reply_ms: sorted.length ? sorted[sorted.length - 1]! : null,
    overlaps,
    clarification_requests: clarifications,
    agent_talk_ms: talk("agent"),
    owner_talk_ms: talk("user"),
    duration_ms: turns.length ? turns[turns.length - 1]!.endMs - turns[0]!.startMs : 0,
    score: Math.round(score * 100) / 100,
  };
}
