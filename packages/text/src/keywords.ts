/**
 * The keyword layer. Runs on every inbound text before anything else, and never
 * calls a model: STOP, HELP, PAUSE, UNDO and RESUME are decided here by exact
 * rules, so an opt-out is honored even when the model is down or the key is unset.
 *
 * Revocation follows FCC 47 CFR 64.1200(a)(10)-(12): any reasonable means counts,
 * so besides the per se words we honor plain-language phrases ("please stop
 * texting me", "wrong number"). Over-triggering STOP is the legally safe error.
 */

export const KEYWORDS = ["stop", "help", "pause", "undo", "resume"] as const;
export type Keyword = (typeof KEYWORDS)[number];

export interface KeywordMatch {
  keyword: Keyword;
  /** Which rule matched, for the event log. */
  rule: string;
  /** PAUSE only: how long, when the owner said ("pause for 2 weeks"). Null means until RESUME. */
  pause_days?: number | null;
  /** STOP only: the owner says the number is not theirs; flag the business record. */
  wrong_number?: boolean;
}

const EMOJI_MODIFIERS = /\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF}|\u{FE0E}|\u{FE0F}|\u{200D}/gu;
const EMOJI = /\p{Extended_Pictographic}/gu;

/**
 * Lowercase, trim, unify quotes and dashes, strip punctuation and emoji, collapse
 * runs of three or more of the same letter ("yesss" and "nooooo" become "yes" and
 * "no"; "kk" stays). Returns the words, space-joined.
 */
export function normalizeReply(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(EMOJI_MODIFIERS, "")
    .replace(EMOJI, " ")
    .replace(/[-_/]/g, " ")
    .replace(/[^\p{L}\p{N}'$.,:\s]/gu, " ")
    .replace(/(?<![\d$])[.,:](?!\d)/g, " ")
    .replace(/(\p{L})\1{2,}/gu, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** The emoji in a message with skin tones and variation selectors removed ("👍🏽" becomes "👍"). */
export function emojiOnly(text: string): string {
  return [...text.replace(EMOJI_MODIFIERS, "").matchAll(EMOJI)].map((m) => m[0]).join("");
}

/** Politeness and filler that never changes what a keyword means. */
const FILLER = new Set(["please", "pls", "plz", "now", "thanks", "thank", "you", "thx", "ok", "okay", "just", "already", "anymore", "sorry", "asap"]);

function withoutFiller(words: string): string {
  return words
    .split(" ")
    .filter((w) => !FILLER.has(w))
    .join(" ");
}

/** Per se opt-out words: the whole message (fillers aside) is one of these. */
const STOP_WORDS = new Set(["stop", "stopall", "stop all", "unsubscribe", "cancel", "end", "quit", "revoke", "opt out", "optout", "stop texting", "stop messaging"]);

/**
 * Plain-language revocations, matched anywhere in the message. "stop by" is not one:
 * every pattern needs a texting verb or an explicit removal request.
 */
const STOP_PHRASES: { name: string; pattern: RegExp }[] = [
  { name: "stop_contacting", pattern: /\bstop (texting|txting|messaging|msging|contacting|sending|calling and texting)\b/ },
  { name: "dont_contact", pattern: /\b(don'?t|do not|dont|never) (text|txt|message|msg|contact|sms) me\b/ },
  { name: "remove_me", pattern: /\b(remove|delete) (me|my number)\b/ },
  { name: "take_me_off", pattern: /\btake me off\b/ },
  { name: "opt_me_out", pattern: /\bopt me out\b/ },
  { name: "leave_me_alone", pattern: /\bleave me alone\b/ },
  { name: "lose_my_number", pattern: /\blose my number\b/ },
  { name: "wrong_number", pattern: /\bwrong (number|person|#)\b/ },
  { name: "not_my_number", pattern: /\b(this|that) is not (my|a) (shop|business)\b/ },
];

/**
 * "don't text me before 9am" restricts when, it does not revoke. A revocation
 * phrase directly followed by a time qualifier is left to the next layer, which
 * may still read it as STOP (the safe error) or as a rule edit.
 */
const TEMPORAL_QUALIFIER = /^\s*(before|after|until|till|til|on|at|during|between|in the|so early|so late|on weekends|weekends|at night|in the morning|in the evening|while)\b/;

const HELP_WORDS = new Set(["help", "info", "information"]);
const UNDO_WORDS = new Set(["undo", "undo that", "undo it", "undo this"]);
const RESUME_WORDS = new Set(["start", "unstop", "join", "resume", "subscribe", "start again", "resume texts"]);

const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const PAUSE = /^pause(?: texts?| messages?)?(?: for)?(?: (\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten) ?(d|day|days|w|wk|wks|week|weeks|month|months))?$/;

/** Cyrillic and Greek letters that render like Latin ones, so "ѕтор" reads as "stop". */
const CONFUSABLES: Record<string, string> = {
  а: "a", в: "b", е: "e", ё: "e", і: "i", ї: "i", ј: "j", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", ѕ: "s", ԁ: "d", һ: "h", ӏ: "l", ԛ: "q", ԝ: "w",
  α: "a", β: "b", ε: "e", η: "n", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x",
};
const CONFUSABLE = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "gu");

/**
 * A keyword written to dodge the exact rules: fullwidth letters ("ＳＴＯＰ"), invisible
 * format characters inside a word ("S\u200BTOP"), look-alike letters ("ѕтор") or one
 * letter at a time ("S T O P"). Folded for the keyword layer only, where reading too
 * much as STOP is the safe error; the rest of the classifier sees the reply as sent.
 */
export function foldDisguises(text: string): string {
  const folded = normalizeReply(text.normalize("NFKC").replace(/\p{Cf}/gu, "").toLowerCase().replace(CONFUSABLE, (c) => CONFUSABLES[c]!));
  return /^(\p{L} )+\p{L}$/u.test(folded) ? folded.replace(/ /g, "") : folded;
}

/** Returns the keyword a message carries, or null. Pure and synchronous: no model, no I/O. */
export function matchKeyword(text: string): KeywordMatch | null {
  const exact = matchNormalized(normalizeReply(text));
  if (exact) return exact;
  const folded = foldDisguises(text);
  if (folded === normalizeReply(text)) return null;
  const disguised = matchNormalized(folded);
  return disguised ? { ...disguised, rule: `${disguised.rule} (disguised)` } : null;
}

function matchNormalized(words: string): KeywordMatch | null {
  const core = withoutFiller(words);
  if (!words) return null;

  if (STOP_WORDS.has(core) || STOP_WORDS.has(words)) return { keyword: "stop", rule: `opt-out word: ${core || words}` };
  for (const { name, pattern } of STOP_PHRASES) {
    const m = pattern.exec(words);
    if (!m) continue;
    const after = words.slice(m.index + m[0].length);
    if (name !== "wrong_number" && TEMPORAL_QUALIFIER.test(after)) continue;
    return { keyword: "stop", rule: `opt-out phrase: ${name}`, ...(name === "wrong_number" ? { wrong_number: true } : {}) };
  }

  if (HELP_WORDS.has(core)) return { keyword: "help", rule: `help word: ${core}` };

  const pause = PAUSE.exec(core);
  if (pause) {
    let days: number | null = null;
    if (pause[1] && pause[2]) {
      const n = /^\d+$/.test(pause[1]) ? Number(pause[1]) : (NUMBER_WORDS[pause[1]] ?? 1);
      const unit = pause[2];
      days = unit.startsWith("m") ? n * 30 : unit.startsWith("w") ? n * 7 : n;
    }
    return { keyword: "pause", rule: "pause word", pause_days: days };
  }

  if (UNDO_WORDS.has(core)) return { keyword: "undo", rule: "undo word" };
  if (RESUME_WORDS.has(core)) return { keyword: "resume", rule: `resume word: ${core}` };
  return null;
}
