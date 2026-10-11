import { maskNumber, parseAllowedNumbers } from "./config";

/**
 * Non-negotiable 6: only call or message numbers in ALLOWED_NUMBERS.
 * Every adapter that can reach a phone (real Dial, FakeDial, outbound text)
 * calls this immediately before the network request. It is the lowest layer.
 */
export class NumberNotAllowedError extends Error {
  constructor(public readonly number: string) {
    super(`Refusing to contact ${maskNumber(number)}: it is not in ALLOWED_NUMBERS`);
    this.name = "NumberNotAllowedError";
  }
}

export function assertAllowedNumber(
  number: string,
  allowed: readonly string[] = parseAllowedNumbers(process.env.ALLOWED_NUMBERS),
): void {
  if (!allowed.includes(number)) throw new NumberNotAllowedError(number);
}

/** Maximum length of any agent- or owner-supplied text we store or forward. */
export const UNTRUSTED_TEXT_MAX = 500;

const COMMON_TLDS = "com|net|org|io|co|ly|me|app|dev|info|biz|xyz|link|site|online|ai|gg|tv|us|uk|ca";

/**
 * Anything that reads as a link: a `scheme:` token (https://, ftp://, tel:, sms:, mailto:,
 * javascript:), www., a bare domain with a path (bit.ly/3xYz) or on a common TLD (example.org).
 * A scheme must start with a letter and be followed by a non-space, so "2:00pm" and "Notes: x" survive.
 * Schemes and www. match mid-word too ("1http://", "httpwww."): gluing a link to a word does not hide it.
 */
const URL_PATTERN = new RegExp(
  String.raw`[a-z][a-z\d+.-]*:\S+|www\.\S*|(?<![\p{L}\p{N}_-])(?:(?:[\p{L}\p{N}-]+\.)+\p{L}{2,63}\/\S*|(?:[\p{L}\p{N}-]+\.)+(?:${COMMON_TLDS})(?![\p{L}\p{N}_]))`,
  "giu",
);

/**
 * Characters that render as nothing or reorder what is shown: C0 and C1 controls, the soft
 * hyphen, zero-width spaces and joiners, bidi embeddings, overrides and isolates, invisible
 * operators and the byte-order mark. Left in, "evil\u200B.com/x" reads as a link on a phone
 * while slipping past the link pattern, and a bidi override can make a line read backwards.
 */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;

/** Fullwidth ASCII (ｈｔｔｐｓ：／／) folds to ASCII, so a homoglyph scheme or domain is still a link. */
const FULLWIDTH = /[\uFF01-\uFF5E]/g;
const foldFullwidth = (text: string) => text.replace(FULLWIDTH, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/**
 * Non-negotiable 5: agent- and owner-supplied text is data. Fold fullwidth
 * homoglyphs, drop invisible and control characters, strip links (including
 * internationalised domains), collapse whitespace, cap length. Callers must still isolate it in prompts.
 */
export function sanitizeUntrustedText(input: string, max = UNTRUSTED_TEXT_MAX): string {
  const cleaned = foldFullwidth(input)
    // Invisible characters go first: stripped after the link check, "http\u0000://" would reassemble into a link.
    .replace(INVISIBLE, "")
    .replace(URL_PATTERN, "[link removed]")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}
