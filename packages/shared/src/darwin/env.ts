import { HttpDarwin, type Darwin } from "./client";
import { FakeDarwin } from "./fake";

/**
 * Picks the Darwin implementation from the environment. DARWIN_IMPL=fake|real
 * overrides DEMO_MODE, so a fakes demo can still hit live Search when wanted.
 */
export function createDarwin(env: NodeJS.ProcessEnv = process.env): Darwin {
  const impl = env.DARWIN_IMPL ?? (env.DEMO_MODE === "live" ? "real" : "fake");
  if (impl !== "fake" && impl !== "real") throw new Error(`DARWIN_IMPL must be fake or real, got ${impl}`);
  if (impl === "fake") return new FakeDarwin();
  return new HttpDarwin({
    baseUrl: env.DARWIN_API_BASE_URL || undefined,
    apiKey: env.DARWIN_API_KEY || undefined,
    actToken: env.DARWIN_ACT_TOKEN || undefined,
  });
}
