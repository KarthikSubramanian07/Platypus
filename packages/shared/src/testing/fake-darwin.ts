import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export type FakeDarwinMode = "match" | "no_match" | "error_500";

interface Recording {
  _provenance: Record<string, unknown>;
  status: number;
  body: unknown;
}

const FILES: Record<FakeDarwinMode, string> = {
  match: "darwin-match.recorded.json",
  no_match: "darwin-no-match.synthetic.json",
  error_500: "darwin-error-500.recorded.json",
};

export function loadDarwinRecording(mode: FakeDarwinMode): Recording {
  return JSON.parse(readFileSync(join(FIXTURES, FILES[mode]), "utf8")) as Recording;
}

/**
 * A fetch() stand-in for api.darwin.so, for tests only.
 *  match:     a real recorded completed response (5 agents, none ready).
 *  error_500: the real HTTP 500 the demo query returned on 2026-10-11.
 *  no_match:  SYNTHETIC until Darwin returns a real one; labeled as such in its body.
 * Refuses to run when DEMO_MODE=live: a simulated Darwin answer must never reach a judge.
 */
export function createFakeDarwinFetch(mode: FakeDarwinMode, env: NodeJS.ProcessEnv = process.env): typeof fetch {
  if (env.DEMO_MODE === "live") throw new Error("FakeDarwin is test-only and refuses to run with DEMO_MODE=live");
  const recording = loadDarwinRecording(mode);
  const calls: { url: string; body: unknown }[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("/api/v3/search")) return new Response(JSON.stringify({ code: "NOT_FOUND" }), { status: 404 });
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(recording.body), {
      status: recording.status,
      headers: { "content-type": "application/json", "x-fake-darwin": mode },
    });
  }) as typeof fetch & { calls: typeof calls };
  fake.calls = calls;
  return fake;
}
