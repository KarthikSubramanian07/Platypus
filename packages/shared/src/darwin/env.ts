import { createFakeDarwinFetch, type FakeDarwinMode } from "../testing/fake-darwin";
import { HttpDarwin, type Darwin } from "./client";

/**
 * Picks the Darwin implementation from the environment. DARWIN_IMPL=fake|real
 * overrides DEMO_MODE, so a fakes demo can still hit live Search when wanted.
 * The fake is the real client over a recorded api.darwin.so, so fakes mode
 * exercises the same parsing, ladder and error handling as live.
 */
export function createDarwin(env: NodeJS.ProcessEnv = process.env, options: { fakeMode?: FakeDarwinMode } = {}): Darwin {
  const impl = env.DARWIN_IMPL || (env.DEMO_MODE === "live" ? "real" : "fake");
  if (impl !== "fake" && impl !== "real") throw new Error(`DARWIN_IMPL must be fake or real, got ${impl}`);
  if (impl === "fake") {
    return new HttpDarwin({ fetch: createFakeDarwinFetch(options.fakeMode ?? "listed", env), maxRetries: 0 });
  }
  return new HttpDarwin({
    baseUrl: env.DARWIN_API_BASE_URL || undefined,
    apiKey: env.DARWIN_API_KEY || undefined,
    actToken: env.DARWIN_ACT_TOKEN || undefined,
  });
}
