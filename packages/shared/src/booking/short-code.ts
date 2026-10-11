import { randomInt } from "node:crypto";

/** No 0/O, 1/I/L: short codes are read aloud on calls and typed on phones. */
export const SHORT_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** SAL-4K2: business prefix plus three unambiguous characters. */
export function generateShortCode(prefix: string, random: (max: number) => number = randomInt): string {
  let suffix = "";
  for (let i = 0; i < 3; i++) suffix += SHORT_CODE_ALPHABET[random(SHORT_CODE_ALPHABET.length)];
  return `${prefix.toUpperCase()}-${suffix}`;
}

export const SHORT_CODE_PATTERN = /^[A-Z]{2,4}-[2-9A-HJKMNP-Z]{3}$/;
