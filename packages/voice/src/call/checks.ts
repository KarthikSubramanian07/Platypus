import { YES_RE, type TimedTurn } from "../mining/deterministic";
import { DISCLOSURE } from "./instruction";

/** Lowercase words only: "Hi, this is a customer's..." and "hi this is a customers" compare equal. */
export const words = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/['’‘]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

export interface DisclosureCheck {
  ok: boolean;
  /** Share of the disclosure's words found, in order, at the start of the agent's first words. */
  similarity: number;
  first_agent_words: string | null;
}

/**
 * Non-negotiable 2, verified after the fact: Dial has no setting that forces a
 * first sentence, so we check the transcript. The agent's opening (its first
 * turn, joined with any agent turns before the owner speaks again) must start
 * with DISCLOSURE, ignoring case and punctuation. The owner may speak first
 * ("Sal's Auto?"); that is expected and allowed.
 */
export function checkDisclosure(turns: readonly TimedTurn[]): DisclosureCheck {
  const expectedWords = words(DISCLOSURE);
  // A first attempt cut off when both sides speak at once ("Hi, this", then the full line)
  // is still a disclosure-first opening, so skip agent turns that are only a prefix of it.
  // Anything else said before the disclosure still fails.
  const isClippedStart = (text: string) => {
    const w = words(text);
    return w.length > 0 && w.length < expectedWords.length && w.every((word, i) => expectedWords[i] === word);
  };
  let first = turns.findIndex((t) => t.speaker === "agent");
  while (first >= 0 && isClippedStart(turns[first]!.text)) {
    const next = turns.findIndex((t, i) => i > first && t.speaker === "agent");
    if (next < 0) break;
    first = next;
  }
  if (first < 0) return { ok: false, similarity: 0, first_agent_words: null };
  const opening: string[] = [];
  for (let i = first; i < turns.length && turns[i]!.speaker === "agent"; i++) opening.push(turns[i]!.text);
  const said = words(opening.join(" "));
  const expected = words(DISCLOSURE);
  let matched = 0;
  while (matched < expected.length && said[matched] === expected[matched]) matched++;
  const ok = matched === expected.length;
  // When the prefix breaks, also count how many words are present at all: a high
  // share with a failed prefix usually means a transcription slip, not a skipped line.
  const present = expected.filter((w) => said.slice(0, expected.length + 4).includes(w)).length;
  const similarity = ok ? 1 : Math.round((Math.max(matched, present) / expected.length) * 100) / 100;
  return { ok, similarity, first_agent_words: opening.join(" ").slice(0, 300) };
}

/** Share of the quote's words that appear in `text` (order-free). */
export function tokenSimilarity(quote: string, text: string): number {
  const q = words(quote);
  if (q.length === 0) return 0;
  const t = new Set(words(text));
  return q.filter((w) => t.has(w)).length / q.length;
}

export interface QuoteCheck {
  verified: boolean;
  similarity: number;
  turn_index: number | null;
}

/** A quote a tool stored (verbal_confirmation, consent quote) must match something the owner actually said. */
export function verifyQuote(quote: string, turns: readonly TimedTurn[], threshold = 0.8): QuoteCheck {
  let best = 0;
  let bestIndex: number | null = null;
  turns.forEach((t, i) => {
    if (t.speaker !== "user") return;
    const s = tokenSimilarity(quote, t.text);
    if (s > best) {
      best = s;
      bestIndex = i;
    }
  });
  return { verified: best >= threshold, similarity: Math.round(best * 100) / 100, turn_index: bestIndex };
}

/**
 * The owner's yes to booking: an affirmative user turn straight after an agent
 * turn that offers to book or asks to confirm the details.
 */
export function findBookingAgreement(turns: readonly TimedTurn[]): { turnIndex: number; quote: string } | null {
  for (let i = 1; i < turns.length; i++) {
    const prev = turns[i - 1]!;
    const turn = turns[i]!;
    if (turn.speaker !== "user" || prev.speaker !== "agent") continue;
    if (!/\b(book|confirm|go ahead|lock (it|that) in)\b/i.test(prev.text)) continue;
    if (/text you instead/i.test(prev.text)) continue; // the consent question is not a booking yes
    if (YES_RE.test(turn.text) || /\b(booked|book it|do it|works for me|that'?s right|correct)\b/i.test(turn.text)) {
      return { turnIndex: i, quote: turn.text };
    }
  }
  return null;
}
