import type { FakeDial } from "@platypus/shared/testing";
import { DialApiError, type DialCalls } from "./client";
import { unwrapCall, type WireCall } from "./wire";

/**
 * Adapts the shared FakeDial to the DialCalls interface so the call service runs
 * unchanged in tests and in DEMO_MODE=fakes. Construct FakeDial WITHOUT its `db`
 * option: the call service owns the calls table and the call.* events. Pass
 * `voiceTools: createFakeGateway({db, ...})` if the scripted call should book
 * mid-call. Mirrors Dial's Idempotency-Key replay and its 400 on stopping an
 * ended call.
 */
export function createFakeDialCalls(fake: FakeDial, options: { fromNumberId?: string } = {}): DialCalls {
  const byKey = new Map<string, string>();
  return {
    async placeCall(input, { idempotencyKey, link }) {
      const replay = byKey.get(idempotencyKey);
      if (replay) return unwrapCall(fake.getCall(replay));
      const { call } = await fake.placeCall(
        {
          to: input.to,
          fromNumberId: input.fromNumberId ?? options.fromNumberId ?? "num_fake",
          outboundInstruction: input.outboundInstruction,
          ...(input.language ? { language: input.language } : {}),
          ...(input.maxCallDurationSeconds !== undefined ? { maxCallDurationSeconds: input.maxCallDurationSeconds } : {}),
        },
        link ?? {},
      );
      byKey.set(idempotencyKey, call.id);
      return unwrapCall(call);
    },
    async listCalls(query = {}) {
      const all: WireCall[] = fake.listCalls().calls.map((c) => unwrapCall(c));
      return query.contact ? all.filter((c) => c.to === query.contact || c.from === query.contact) : all;
    },
    async getCall(id) {
      return unwrapCall(fake.getCall(id));
    },
    async stopCall(id) {
      try {
        return { cancelPending: false, call: unwrapCall(fake.stopCall(id)) };
      } catch (error) {
        throw new DialApiError(400, "call_not_active", (error as Error).message);
      }
    },
    on(listener) {
      return fake.on((event) => listener(event));
    },
  };
}
