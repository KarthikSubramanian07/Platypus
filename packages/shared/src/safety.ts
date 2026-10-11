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

const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/gi;

/**
 * Non-negotiable 5: agent- and owner-supplied text is data. Strip links,
 * collapse whitespace, cap length. Callers must still isolate it in prompts.
 */
export function sanitizeUntrustedText(input: string, max = UNTRUSTED_TEXT_MAX): string {
  const cleaned = input
    .replace(URL_PATTERN, "[link removed]")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}
