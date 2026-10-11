/**
 * `pnpm audit:log [file.jsonl | url] [--json] [--no-color]`
 *
 * Replays the append-only event log through the auditor and prints one line per
 * non-negotiable: ✓ when it holds, ✗ with every violation when it does not.
 * Exits 1 on any violation, so it can gate CI or a demo run.
 *
 *   pnpm audit:log                                           # the running dev server
 *   pnpm audit:log packages/shared/src/testing/fixtures/golden-path.jsonl
 *   pnpm audit:log http://localhost:8787/events.jsonl --json
 */
import { readFileSync } from "node:fs";
import { auditEventLog, formatAuditReport } from "../packages/shared/src/audit/index";
import { parseJsonl } from "../packages/shared/src/events/log";

const DEFAULT_SOURCE = `http://127.0.0.1:${process.env.PORT ?? 8787}/events.jsonl`;

async function readLog(source: string): Promise<string> {
  if (/^https?:\/\//.test(source)) {
    // Through the tunnel the log needs DASHBOARD_TOKEN; on this machine it is open.
    const token = process.env.DASHBOARD_TOKEN?.trim();
    const res = await fetch(source, { signal: AbortSignal.timeout(10_000), ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });
    if (!res.ok) throw new Error(`GET ${source} answered ${res.status}`);
    return res.text();
  }
  return readFileSync(source, "utf8");
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const color = !args.includes("--no-color") && Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const source = args.find((a) => !a.startsWith("--")) ?? DEFAULT_SOURCE;

  let text: string;
  try {
    text = await readLog(source);
  } catch (error) {
    console.error(`Could not read the event log from ${source}: ${(error as Error).message}`);
    if (source === DEFAULT_SOURCE) console.error("Start the server with `pnpm dev`, or pass a JSONL file.");
    return 2;
  }

  let events;
  try {
    events = parseJsonl(text);
  } catch (error) {
    console.error(`${source} is not valid JSONL: ${(error as Error).message}`);
    return 2;
  }

  const result = auditEventLog(events);
  console.log(json ? JSON.stringify(result, null, 2) : formatAuditReport(result, { color, source }));
  return result.ok ? 0 : 1;
}

process.exitCode = await main();
