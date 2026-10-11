/**
 * The stage fallback: any MCP client can drive the golden path, so if Claude Desktop hangs,
 * run `pnpm --filter @platypus/gateway demo:cli oil` (or `brakes`, `tools`) against `pnpm dev`.
 * Plain lines for a projector; a failed call prints one line and exits 1.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { GatewayToolName, GatewayTools } from "@platypus/shared/contracts";
import { AGENT_HEADER } from "./mcp";

export const DEFAULT_URL = "http://localhost:8787/mcp";
const AGENT_ID = "demo-cli";
const USAGE = "Usage: demo:cli [oil|brakes|tools] [--url http://localhost:8787/mcp]";
const LOCATION = "1025 Sansome St, San Francisco";
const BUDGET_CENTS = 12000;
const REQUESTED_BY = "Alex's assistant";
const NOTES = "2019 Civic";
const POLL_MS = 2000;
const TIMEOUT_MS = 150_000;
const WAITING = new Set(["pending", "quote_pending"]);

type Output<K extends GatewayToolName> = Awaited<ReturnType<GatewayTools[K]>>;
type Input<K extends GatewayToolName> = Parameters<GatewayTools[K]>[0];
type Window = Input<"request_booking">["window"];

export interface CliOptions {
  token?: string;
  fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
  print?: (line: string) => void;
  pollMs?: number;
  timeoutMs?: number;
  now?: () => Date;
}

/** `dayOffset` days from `base`, at `hour`:00 local time, as ISO-8601. */
const localAt = (base: Date, dayOffset: number, hour: number): string => {
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

const SCENARIOS: Record<string, { service: string; window: (now: Date) => Window }> = {
  oil: { service: "oil change", window: (now) => ({ start: localAt(now, 1, 12), end: localAt(now, 1, 17) }) },
  brakes: {
    service: "brake inspection",
    window: (now) => {
      const toNextMonday = (8 - now.getDay()) % 7 || 7;
      return { start: localAt(now, toNextMonday + 1, 9), end: localAt(now, toNextMonday + 3, 17) };
    },
  },
};

const firstLine = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0]?.trim() || "unknown error";

const money = (cents: number): string => `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`;

/** "Tue 2:00pm" in the machine's time zone (set TZ to override). */
const when = (iso: string): string => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.weekday} ${parts.hour}:${parts.minute}${String(parts.dayPeriod).toLowerCase()}`;
};

async function call<K extends GatewayToolName>(client: Client, name: K, args: Input<K>): Promise<Output<K>> {
  let result;
  try {
    result = await client.callTool({ name, arguments: args });
  } catch (error) {
    throw new Error(`${name} failed: ${firstLine(error)}`, { cause: error });
  }
  if (result.isError) {
    const [content] = result.content as Array<{ type: string; text?: string }>;
    throw new Error(content?.text?.split("\n")[0] || `${name} failed`);
  }
  return result.structuredContent as Output<K>;
}

const darwinLine = ({ darwin }: Output<"search_providers">): string => {
  const detail = darwin.no_match_reason ?? darwin.question ?? (darwin.agents.length ? `${darwin.agents.length} agent(s)` : "");
  const extras = [darwin.cached ? "cached" : "", darwin.latency_ms === undefined ? "" : `${darwin.latency_ms}ms`].filter(Boolean);
  return `Darwin: ${darwin.status}${detail ? `, ${detail}` : ""}${extras.length ? ` (${extras.join(", ")})` : ""}`;
};

const providerLine = (p: Output<"search_providers">["providers"][number]): string => {
  const s = p.signals;
  const facts = [
    p.channel_state,
    s.typical_price_cents === undefined ? "" : `typical ${money(s.typical_price_cents)}`,
    s.median_reply_seconds === undefined ? "" : `replies in ~${Math.round(s.median_reply_seconds / 60)}m`,
    s.acceptance_rate === undefined ? "" : `${Math.round(s.acceptance_rate * 100)}% accept`,
    `next step: ${p.next_step}`,
  ].filter(Boolean);
  return `Top provider: ${p.display_name}${p.address ? `, ${p.address}` : ""} (${facts.join(", ")})`;
};

const finalLine = (b: Output<"get_booking">): string => {
  const details = [b.slot ? when(b.slot.start) : "", b.price_cents === null ? "" : money(b.price_cents), `code ${b.short_code}`].filter(Boolean);
  if (b.status === "confirmed") return `Booked: ${b.provider_name}, ${details.join(", ")}`;
  if (b.status === "countered") return `Countered: ${b.provider_name} proposed ${details.join(", ")}`;
  return `Not booked: ${b.status}, ${b.provider_name}, code ${b.short_code}`;
};

async function bookGoldenPath(client: Client, scenario: (typeof SCENARIOS)[string], opts: Required<Omit<CliOptions, "token" | "fetch">>): Promise<number> {
  const { print } = opts;
  const window = scenario.window(opts.now());
  print(`Searching: ${scenario.service} near ${LOCATION}, budget ${money(BUDGET_CENTS)}`);
  const found = await call(client, "search_providers", { service: scenario.service, location: LOCATION, window, budget_cents: BUDGET_CENTS });
  print(darwinLine(found));
  const top = found.providers[0];
  if (!top) {
    print(`No providers found for ${scenario.service}`);
    return 1;
  }
  print(providerLine(top));

  const requested = await call(client, "request_booking", {
    provider_id: top.provider_id,
    service: scenario.service,
    window,
    requested_by: REQUESTED_BY,
    notes: NOTES,
    idempotency_key: randomUUID(),
  });
  print(`Requested: ${requested.short_code} via ${requested.route}${requested.reasons.length ? ` (${requested.reasons.join("; ")})` : ""}`);

  const started = Date.now();
  let last = "";
  for (;;) {
    const booking = await call(client, "get_booking", { booking_id: requested.booking_id });
    const elapsed = Math.round((Date.now() - started) / 1000);
    if (booking.status !== last) print(`Status: ${booking.status} (${elapsed}s)`);
    last = booking.status;
    if (!WAITING.has(booking.status)) {
      print(finalLine(booking));
      return 0;
    }
    if (Date.now() - started >= opts.timeoutMs) {
      print(`Still ${booking.status} after ${elapsed}s, code ${booking.short_code}`);
      return 1;
    }
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs));
  }
}

/** Runs one subcommand against the gateway at --url and returns the exit code. Never throws. */
export async function run(argv: string[], options: CliOptions = {}): Promise<number> {
  const print = options.print ?? ((line: string) => console.log(line));
  let url: URL;
  let command: string;
  try {
    const { values, positionals } = parseArgs({ args: argv, options: { url: { type: "string" } }, allowPositionals: true });
    url = new URL(values.url ?? DEFAULT_URL);
    command = positionals[0] ?? "oil";
  } catch (error) {
    print(`${firstLine(error)}. ${USAGE}`);
    return 1;
  }
  const scenario = SCENARIOS[command];
  if (command !== "tools" && !scenario) {
    print(`Unknown command "${command}". ${USAGE}`);
    return 1;
  }

  const token = options.token ?? process.env.GATEWAY_TOKEN;
  const headers: Record<string, string> = { [AGENT_HEADER]: AGENT_ID, ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers }, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const client = new Client({ name: AGENT_ID, version: "0.1.0" });
  try {
    try {
      await client.connect(transport);
    } catch (error) {
      print(`Cannot reach the gateway at ${url.href}: ${firstLine(error)}`);
      return 1;
    }
    if (!scenario) {
      const { tools } = await client.listTools();
      for (const tool of tools) print(tool.name);
      return 0;
    }
    return await bookGoldenPath(client, scenario, {
      print,
      pollMs: options.pollMs ?? POLL_MS,
      timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
      now: options.now ?? (() => new Date()),
    });
  } catch (error) {
    print(firstLine(error));
    return 1;
  } finally {
    await client.close().catch(() => undefined);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // `pnpm dev` reads GATEWAY_TOKEN from the repo's .env, so the CLI does too.
  const rootEnv = fileURLToPath(new URL("../../../.env", import.meta.url));
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
  void run(process.argv.slice(2)).then((code) => process.exit(code));
}
