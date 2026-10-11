import type { Classification } from "@platypus/shared/contracts";
import { emojiOnly, matchKeyword, normalizeReply, type Keyword, type KeywordMatch } from "./keywords";
import type { ModelOutput, ReplyModel } from "./model";
import { formatCents, parseMoney } from "./money";
import { formatLong, localDate, parseExtractedTime, parseWholeTime, type ParsedTime, type TimeAnchor } from "./time";

/**
 * Reply understanding, in three layers:
 *
 *  1. Deterministic: keywords (STOP, HELP, PAUSE, UNDO, RESUME), reactions, the
 *     yes and no lexicons, and replies that are only a time or only a price.
 *     It returns null (abstains) on everything else. No model is ever called for
 *     a message this layer decides.
 *  2. Model: Claude reads the rest and extracts what it can (model.ts).
 *  3. Threshold: code, not the model, decides whether to act. A model "accept"
 *     confirms a booking only when it clears ACCEPT_THRESHOLD, the reply contains
 *     an explicit yes, and nothing extracted contradicts the offer. Otherwise the
 *     owner gets a one-line question. Zero false accepts is the design goal.
 */

export type ReplyingTo = "new_request" | "autopilot_report" | "daily_summary" | "clarify" | "none";
export type ReactionKind = "like" | "love" | "emphasize" | "dislike" | "question" | "laugh" | "other";
export type ReplyAction = "confirm" | "decline" | "counter" | "clarify" | "note" | "keyword";
export type ClassifyMethod = "deterministic" | "model" | "fallback";

/** What we offered, so a reply can be checked against it. */
export interface Offer {
  service: string;
  /** ISO-8601; the slot we held, if any. */
  slot_start: string | null;
  window_start?: string | null;
  price_cents?: number | null;
}

export interface ReplyContext {
  now: Date;
  /** The business's IANA zone; every time is resolved in it. */
  timeZone: string;
  replying_to?: ReplyingTo;
  offer?: Offer | null;
  /** Dial's `reaction` on an iMessage Tapback (an emoji or a name such as "like"). */
  reaction?: string | null;
}

export interface ClassifyResult {
  /** The contract shape stored on the message and emitted in reply.classified. */
  classification: Classification;
  method: ClassifyMethod;
  /** What the inbound handler should do with it. */
  action: ReplyAction;
  keyword: Keyword | null;
  keyword_match: KeywordMatch | null;
  reaction: ReactionKind | null;
  /** The proposed time, resolved in the business's zone. */
  time: ParsedTime | null;
  /** Why, in one line, for the event log. */
  reason: string;
  /** The model's raw output, when the model ran. */
  model?: ModelOutput;
}

/** A model accept must reach this to auto-confirm. Code caps accepts without an explicit yes at 0.85, below it. */
export const ACCEPT_THRESHOLD = 0.9;
/** Every other model class must reach this to be acted on; below it, the owner is asked. */
export const ACT_THRESHOLD = 0.7;
export const REACTION_CONFIDENCE_CAP = 0.6;
export const IMPLICIT_ACCEPT_CAP = 0.85;

const ACCEPT_WORDS = new Set([
  "y", "yes", "yep", "yup", "yeah", "yea", "ya", "ok", "okay", "k", "kk", "sure", "sure thing", "sounds good", "works",
  "confirmed", "confirm", "si", "sí", "yes please", "ok sounds good", "yes sir", "absolutely", "will do", "deal",
]);
const ACCEPT_EMOJI = new Set(["👍", "👌", "✅", "👍👍", "🙌"]);
const DECLINE_WORDS = new Set(["n", "no", "nope", "nah", "no thanks", "no thank you", "can't", "cant", "cannot", "pass", "not this time", "no sorry", "sorry no"]);
const DECLINE_EMOJI = new Set(["👎"]);
const YES_TOKENS = new Set(["y", "yes", "yep", "yup", "yeah", "ya", "si", "sí"]);
/**
 * Words that turn a yes into a no, a condition or an excuse ("yes but not tomorrow", "yeah no",
 * "yes, unless it rains"). With any of them, or a question mark, a model accept asks instead:
 * the model may have misread the reply, or been talked into it, and asking costs one text.
 */
const CONTRADICTS_YES = new Set([
  "no", "not", "nope", "nah", "never", "cant", "can't", "cannot", "wont", "won't", "dont", "don't", "unable",
  "busy", "slammed", "but", "though", "unless", "instead", "except", "if", "ignore", "instructions",
]);
/** True when one whole word of the normalized reply is a yes ("y'all" is not). */
const hasExplicitYes = (words: string): boolean => words.split(" ").some((w) => YES_TOKENS.has(w));

const TAPBACK_TEXT = /^(Liked|Loved|Disliked|Laughed at|Emphasized|Questioned) [“"](.+)[”"]$/s;
const TAPBACK_REACTED = /^Reacted (.+?) to [“"](.+)[”"]$/s;

function reactionKind(raw: string): ReactionKind {
  const r = raw.trim().toLowerCase();
  if (["like", "liked", "👍"].includes(r) || r.startsWith("👍")) return "like";
  if (["love", "loved", "❤️", "❤", "♥️", "😍"].includes(r)) return "love";
  if (["emphasize", "emphasized", "‼️", "!!", "❗"].includes(r)) return "emphasize";
  if (["dislike", "disliked", "👎"].includes(r) || r.startsWith("👎")) return "dislike";
  if (["question", "questioned", "❓", "?"].includes(r)) return "question";
  if (["laugh", "laughed at", "haha", "😂", "🤣"].includes(r)) return "laugh";
  return "other";
}

/** A Tapback, from Dial's `reaction` field or from its SMS rendering (`Liked “…”`). */
export function detectReaction(text: string, reaction?: string | null): ReactionKind | null {
  if (reaction) return reactionKind(reaction);
  const t = text.trim();
  const m = TAPBACK_TEXT.exec(t);
  if (m) return reactionKind(m[1]!);
  const r = TAPBACK_REACTED.exec(t);
  if (r) return reactionKind(r[1]!);
  return null;
}

function anchorOf(ctx: ReplyContext): TimeAnchor {
  const anchorIso = ctx.offer?.slot_start ?? ctx.offer?.window_start ?? null;
  return { now: ctx.now, timeZone: ctx.timeZone, anchorDate: anchorIso ? localDate(new Date(anchorIso), ctx.timeZone) : null };
}

/** True when a proposed time is the slot we offered (so it is a yes in disguise, to be confirmed by asking). */
export function matchesOffer(time: ParsedTime | null, offer: Offer | null | undefined): boolean {
  if (!time || !offer?.slot_start) return false;
  if (!time.iso) return false;
  return new Date(time.iso).getTime() === new Date(offer.slot_start).getTime();
}

function result(
  cls: Classification["class"],
  confidence: number,
  action: ReplyAction,
  reason: string,
  extra: Partial<Omit<ClassifyResult, "classification" | "action" | "reason">> & { extracted?: Classification["extracted"] } = {},
): ClassifyResult {
  const { extracted, ...rest } = extra;
  return {
    classification: { class: cls, confidence, ...(extracted && Object.keys(extracted).length ? { extracted } : {}) },
    method: "deterministic",
    action,
    keyword: null,
    keyword_match: null,
    reaction: null,
    time: null,
    reason,
    ...rest,
  };
}

/**
 * Layer 1. Exact rules only; returns null (abstains) whenever a reply needs judgment.
 * Synchronous and pure, so it provably cannot reach a model.
 */
export function classifyDeterministic(text: string, ctx: ReplyContext): ClassifyResult | null {
  const reaction = detectReaction(text, ctx.reaction);
  if (reaction) {
    // A reaction never books. A like asks for an explicit Y; a dislike is a no.
    if (reaction === "dislike") return result("decline", REACTION_CONFIDENCE_CAP, "decline", "reaction: dislike", { reaction });
    return result("question", Math.min(0.5, REACTION_CONFIDENCE_CAP), "clarify", `reaction: ${reaction}; asking for an explicit Y`, { reaction });
  }

  const kw = matchKeyword(text);
  if (kw) {
    const cls: Classification["class"] =
      kw.keyword === "stop" ? "stop" : kw.keyword === "help" ? "help" : kw.keyword === "pause" ? "pause" : kw.keyword === "undo" ? "decline" : "unrelated";
    return result(cls, 1, "keyword", `keyword ${kw.keyword.toUpperCase()} (${kw.rule})`, { keyword: kw.keyword, keyword_match: kw });
  }

  const words = normalizeReply(text);
  if (words === "off" && ctx.replying_to === "daily_summary") {
    return result("availability_update", 1, "note", "OFF in reply to the daily summary");
  }

  const lexicon = words || emojiOnly(text);
  if (ACCEPT_WORDS.has(lexicon) || ACCEPT_EMOJI.has(lexicon)) {
    // "okay?" and "Y?" are the owner asking, not agreeing. Normalizing strips the "?", so check the raw text.
    if (/[?？¿]/.test(text)) return result("question", 0.5, "clarify", `a yes asked as a question (${text.trim().slice(0, 20)}); asking for an explicit Y`);
    return result("accept", hasExplicitYes(lexicon) ? 1 : 0.98, "confirm", `exact match: ${text.trim().slice(0, 20)}`);
  }
  if (DECLINE_WORDS.has(lexicon) || DECLINE_EMOJI.has(lexicon)) {
    return result("decline", 1, "decline", `exact match: ${text.trim().slice(0, 20)}`);
  }

  const time = parseWholeTime(text, anchorOf(ctx));
  if (time) {
    const extracted = { time: time.text };
    if (matchesOffer(time, ctx.offer)) {
      return result("counter", 0.95, "clarify", `the reply names the offered time (${time.text}); asking for an explicit Y`, { time, extracted });
    }
    return result("counter", 0.95, "counter", `the whole reply is a time: ${time.text}`, { time, extracted });
  }

  const money = parseMoney(words);
  if (money) {
    const rest = words
      .replace(money.text.toLowerCase(), " ")
      .replace(/\b(it'?s|it is|its|for|price|total|that'?d be|would be|will be|is|about|around|can do|i can do it for)\b/g, " ")
      .trim();
    if (!rest) return result("counter", 0.95, "counter", `the whole reply is a price: ${formatCents(money.cents)}`, { extracted: { price_cents: money.cents } });
  }
  return null;
}

export interface ClassifyDeps {
  /** Null or absent: no model (no ANTHROPIC_API_KEY). Non-deterministic replies then become a clarifying question. */
  model?: ReplyModel | null;
}

function fallback(reason: string, extra: Partial<ClassifyResult> = {}): ClassifyResult {
  return {
    classification: { class: "question", confidence: 0 },
    method: "fallback",
    action: "clarify",
    keyword: null,
    keyword_match: null,
    reaction: null,
    time: null,
    reason,
    ...extra,
  };
}

/** Layers 2 and 3: the model's reading, then the code that decides whether it may act. */
export function applyThresholds(text: string, out: ModelOutput, ctx: ReplyContext): ClassifyResult {
  const words = normalizeReply(text);
  let confidence = Math.max(0, Math.min(1, out.confidence));
  const time = out.extracted.time ? parseExtractedTime(out.extracted.time, anchorOf(ctx)) : null;
  const price = out.extracted.price_cents ?? null;
  const extracted: Classification["extracted"] = {
    ...(out.extracted.time ? { time: out.extracted.time } : {}),
    ...(price !== null && price >= 0 ? { price_cents: Math.round(price) } : {}),
  };
  const base = { method: "model" as const, keyword: null, keyword_match: null, reaction: null, time, model: out };
  const asked = (why: string): ClassifyResult => ({
    ...base,
    classification: { class: "question", confidence, ...(Object.keys(extracted).length ? { extracted } : {}) },
    action: "clarify",
    reason: why,
  });
  const as = (action: ReplyAction, why: string, cls: Classification["class"] = out.class): ClassifyResult => ({
    ...base,
    classification: { class: cls, confidence, ...(Object.keys(extracted).length ? { extracted } : {}) },
    action,
    reason: why,
  });

  switch (out.class) {
    case "accept": {
      if (/[?？¿]/.test(text) || words.split(" ").some((w) => CONTRADICTS_YES.has(w))) {
        return asked("model said accept, but the reply also says no, sets a condition or asks a question");
      }
      if (!hasExplicitYes(words)) confidence = Math.min(confidence, IMPLICIT_ACCEPT_CAP);
      const timeDiffers = Boolean(out.extracted.time) && !matchesOffer(time, ctx.offer);
      const priceDiffers = price !== null && price !== (ctx.offer?.price_cents ?? null);
      if (timeDiffers || priceDiffers) return asked("model said accept, but the reply names a different time or a price");
      if (confidence < ACCEPT_THRESHOLD) return asked(`model said accept at ${confidence.toFixed(2)}, below ${ACCEPT_THRESHOLD}`);
      return as("confirm", `model: accept at ${confidence.toFixed(2)}`);
    }
    case "stop":
      // Honoring a revocation on a weaker signal is the safe error (FCC: any reasonable means).
      return confidence >= 0.5 ? { ...as("keyword", "model: stop"), keyword: "stop" } : asked("model leaned stop, unsure");
    case "help":
      return confidence >= ACT_THRESHOLD ? { ...as("keyword", "model: help"), keyword: "help" } : asked("model leaned help, unsure");
    case "decline":
      return confidence >= ACT_THRESHOLD ? as("decline", `model: decline at ${confidence.toFixed(2)}`) : asked("model leaned decline, unsure");
    case "counter": {
      if (confidence < ACT_THRESHOLD) return asked("model leaned counter, unsure");
      if (!time && price === null) return asked("model said counter but named no time or price");
      if (matchesOffer(time, ctx.offer) && price === null) return asked("the counter is the offered time; asking for an explicit Y");
      return as("counter", `model: counter at ${confidence.toFixed(2)}`);
    }
    case "rule_edit":
    case "availability_update":
    case "pause":
      return as("note", `model: ${out.class}`);
    case "question":
    case "unrelated":
    default:
      return as("clarify", `model: ${out.class}`);
  }
}

/** Formats the offer for the model's context fields. */
function offerFields(ctx: ReplyContext) {
  const offer = ctx.offer;
  return {
    service: offer?.service ?? null,
    offered_time: offer?.slot_start ? formatLong(offer.slot_start, ctx.timeZone) : null,
    offered_price: typeof offer?.price_cents === "number" ? formatCents(offer.price_cents) : null,
  };
}

/** The full pipeline. STOP, HELP and PAUSE resolve in layer 1 and never reach the model. */
export async function classifyReply(text: string, ctx: ReplyContext, deps: ClassifyDeps = {}): Promise<ClassifyResult> {
  const det = classifyDeterministic(text, ctx);
  if (det) return det;
  if (!deps.model) return fallback("no model configured; asking the owner");
  try {
    const out = await deps.model.classify({ text, replying_to: ctx.replying_to ?? "new_request", ...offerFields(ctx) });
    return applyThresholds(text, out, ctx);
  } catch (error) {
    return fallback(`model unavailable (${(error as Error).name}); asking the owner`);
  }
}
