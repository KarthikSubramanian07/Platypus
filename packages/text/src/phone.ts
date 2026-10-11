import { parsePhoneNumberFromString } from "libphonenumber-js";

/**
 * Normalizes a phone number to E.164, assuming US for national formats.
 * Dial already sends E.164; this is defensive for the events stream and tests.
 * Returns null when the input is not a valid number.
 */
export function toE164(input: string, defaultCountry: "US" = "US"): string | null {
  const parsed = parsePhoneNumberFromString(input.trim(), defaultCountry);
  if (!parsed) return null;
  // Fictional 555-01xx numbers are not "valid" to libphonenumber but are well-formed; accept possible numbers.
  return parsed.isPossible() ? parsed.number : null;
}
