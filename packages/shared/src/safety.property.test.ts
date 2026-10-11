import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sanitizeUntrustedText, UNTRUSTED_TEXT_MAX } from "./safety";

/**
 * Non-negotiable 5 as properties: whatever an agent or an owner sends, the text we
 * store or forward has no link in it, fits the cap, and sanitizing twice changes nothing.
 */

fc.configureGlobal({ seed: Number(process.env.FC_SEED ?? 0x5afe), numRuns: Number(process.env.FC_RUNS ?? 200) });

/** Strings built from the pieces links are made of, plus the characters that try to hide them. */
const linkish = fc.string({
  unit: fc.constantFrom("http", "HTTP", "s", "://", ":", "//", "www", "WWW", ".", "com", "ly", "/", "x", "evil", " ", "\n", "\t", "\u0000", "\u0007", "\u001f", "\u007f", "a", "2:00pm", "…", "\u200B", "\u202E", "\u00AD", "\uFF48", "\uFF0E", "\u0435"),
  maxLength: 60,
});
const anyText = fc.oneof(linkish, fc.string({ unit: "binary", maxLength: 80 }), fc.string({ maxLength: 1200 }));
const LINK = /https?:\/\/|www\./i;

describe("sanitizeUntrustedText, property-based", () => {
  it("never lets a link through", () => {
    fc.assert(
      fc.property(anyText, (s) => {
        expect(sanitizeUntrustedText(s)).not.toMatch(LINK);
      }),
    );
  });

  it("never exceeds the cap, for any cap", () => {
    fc.assert(
      fc.property(anyText, fc.integer({ min: 1, max: 600 }), (s, max) => {
        expect(sanitizeUntrustedText(s, max).length).toBeLessThanOrEqual(max);
        expect(sanitizeUntrustedText(s).length).toBeLessThanOrEqual(UNTRUSTED_TEXT_MAX);
      }),
    );
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(anyText, (s) => {
        const once = sanitizeUntrustedText(s);
        expect(sanitizeUntrustedText(once)).toBe(once);
      }),
    );
  });

  it("leaves no control characters and no runs of whitespace", () => {
    fc.assert(
      fc.property(anyText, (s) => {
        const out = sanitizeUntrustedText(s);
        // eslint-disable-next-line no-control-regex
        expect(out).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]|\s{2,}|^\s|\s$/);
      }),
    );
  });

  // Counterexamples fast-check found, kept as fixed regressions.
  it.each(["http\u0000://evil.example/x", "ww\u0000w.evil.zz", "www.", "WWW. now", "httpwww.evil", "1https://evil.example"])("strips the smuggled link in %j", (s) => {
    const out = sanitizeUntrustedText(s);
    expect(out).not.toMatch(LINK);
    expect(sanitizeUntrustedText(out)).toBe(out);
  });

  it("keeps plain owner replies exactly", () => {
    fc.assert(
      fc.property(fc.constantFrom("Y", "yes", "N", "STOP", "2pm works", "$300", "Can't do tue, how about wed 9:30?"), (s) => {
        expect(sanitizeUntrustedText(s)).toBe(s);
      }),
    );
  });
});
