import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SIGNATURE_TOLERANCE_SECONDS, signDialPayload, verifyDialSignature } from "./webhook";

/**
 * Dial webhook signatures as properties: whatever the body and secret, a correctly
 * signed request verifies inside the tolerance, and changing any single character of
 * the body, the timestamp or the signature, or stepping outside ±300 s, makes it fail.
 */

fc.configureGlobal({ seed: Number(process.env.FC_SEED ?? 0x51e9), numRuns: Number(process.env.FC_RUNS ?? 200) });

const secret = fc.string({ minLength: 1, maxLength: 64 }).map((s) => `whsec_${s}`);
const body = fc.oneof(
  fc.json({ maxDepth: 3 }),
  fc.string({ maxLength: 400 }),
  fc.string({ unit: "grapheme", maxLength: 80 }),
);
const now = fc.integer({ min: 1_700_000_000, max: 2_100_000_000 });
const skew = fc.integer({ min: -SIGNATURE_TOLERANCE_SECONDS, max: SIGNATURE_TOLERANCE_SECONDS });
const header = (t: number, sig: string) => `t=${t},v1=${sig}`;

/** Replaces the character at i with a different one. */
function mutate(s: string, i: number, replacement: string): string {
  return s.slice(0, i) + replacement + s.slice(i + 1);
}

describe("verifyDialSignature, property-based", () => {
  it("accepts every correctly signed body within ±300 s", () => {
    fc.assert(
      fc.property(secret, body, now, skew, (sec, b, n, d) => {
        const t = n + d;
        expect(verifyDialSignature(sec, header(t, signDialPayload(sec, t, b)), b, n)).toEqual({ ok: true });
      }),
    );
  });

  it("rejects any single-character change to the body", () => {
    fc.assert(
      fc.property(secret, body.filter((b) => b.length > 0), now, fc.nat(), fc.string({ minLength: 1, maxLength: 1 }), (sec, b, n, at, c) => {
        const i = at % b.length;
        fc.pre(b[i] !== c);
        const tampered = mutate(b, i, c);
        fc.pre(tampered !== b);
        expect(verifyDialSignature(sec, header(n, signDialPayload(sec, n, b)), tampered, n)).toEqual({ ok: false, reason: "mismatch" });
      }),
    );
  });

  it("rejects any single-digit change to the timestamp", () => {
    fc.assert(
      fc.property(secret, body, now, fc.nat(), fc.integer({ min: 0, max: 9 }), (sec, b, n, at, digit) => {
        const t = String(n);
        const i = at % t.length;
        fc.pre(t[i] !== String(digit));
        const forged = mutate(t, i, String(digit));
        const check = verifyDialSignature(sec, header(Number(forged), signDialPayload(sec, n, b)), b, n);
        expect(check.ok).toBe(false);
      }),
    );
  });

  it("rejects any single-character change to the signature", () => {
    fc.assert(
      fc.property(secret, body, now, fc.nat(63), fc.integer({ min: 0, max: 15 }), (sec, b, n, i, nibble) => {
        const sig = signDialPayload(sec, n, b);
        const hex = nibble.toString(16);
        fc.pre(sig[i] !== hex);
        expect(verifyDialSignature(sec, header(n, mutate(sig, i, hex)), b, n)).toEqual({ ok: false, reason: "mismatch" });
      }),
    );
  });

  it("rejects a valid signature outside the ±300 s window as stale", () => {
    fc.assert(
      fc.property(secret, body, now, fc.integer({ min: SIGNATURE_TOLERANCE_SECONDS + 1, max: 10 * 86_400 }), fc.boolean(), (sec, b, n, off, future) => {
        const t = future ? n + off : n - off;
        expect(verifyDialSignature(sec, header(t, signDialPayload(sec, t, b)), b, n)).toEqual({ ok: false, reason: "stale" });
      }),
    );
  });

  it("rejects a signature made with any other secret", () => {
    fc.assert(
      fc.property(secret, secret, body, now, (a, b, payload, n) => {
        fc.pre(a !== b);
        expect(verifyDialSignature(b, header(n, signDialPayload(a, n, payload)), payload, n).ok).toBe(false);
      }),
    );
  });

  it("never throws on an arbitrary header", () => {
    fc.assert(
      fc.property(fc.option(fc.string({ maxLength: 200 })), body, now, (h, b, n) => {
        expect(() => verifyDialSignature("whsec_x", h, b, n)).not.toThrow();
      }),
    );
  });
});
