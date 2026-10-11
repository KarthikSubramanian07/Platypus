import type { AuditResult } from "./audit";
import { AUDIT_RULES } from "./rules";

export interface ReportOptions {
  /** ANSI colors for a terminal. Off by default (safe for HTTP and files). */
  color?: boolean;
  /** Where the log came from, shown in the header. */
  source?: string;
  /** Violations listed per rule before "and N more". Default 10. */
  maxPerRule?: number;
}

const paint = (on: boolean) => ({
  green: (s: string) => (on ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (on ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (on ? `\x1b[33m${s}\x1b[0m` : s),
  dim: (s: string) => (on ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (on ? `\x1b[1m${s}\x1b[0m` : s),
});

const pairs = (m: Record<string, number>) =>
  Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(", ") || "none";

/** A plain-text report: one line per rule (✓ or ✗), the violations under it, then the stats. */
export function formatAuditReport(result: AuditResult, options: ReportOptions = {}): string {
  const c = paint(options.color ?? false);
  const max = options.maxPerRule ?? 10;
  const { stats } = result;
  const lines: string[] = [];
  const span = stats.first_at && stats.last_at ? ` from ${stats.first_at} to ${stats.last_at}` : "";
  lines.push(c.bold(`Platypus event-log audit${options.source ? `: ${options.source}` : ""}`));
  lines.push(c.dim(`${stats.events} events${span}`));
  lines.push("");

  for (const rule of result.rules) {
    const mark = rule.errors ? c.red("✗") : rule.warnings ? c.yellow("!") : c.green("✓");
    const nn = AUDIT_RULES[rule.id].non_negotiables.join(", ");
    const tally = rule.errors ? c.red(`${rule.errors} violation${rule.errors === 1 ? "" : "s"}`) : rule.warnings ? c.yellow(`${rule.warnings} warning${rule.warnings === 1 ? "" : "s"}`) : c.dim(`${rule.checked} checked`);
    lines.push(`${mark} ${rule.id}  ${rule.title} ${c.dim(`(non-negotiable ${nn})`)}  ${tally}`);
    const found = result.violations.filter((v) => v.rule === rule.id);
    for (const v of found.slice(0, max)) {
      const tag = v.severity === "error" ? c.red("error  ") : c.yellow("warning");
      lines.push(`    ${tag} ${v.message}${v.event_id ? c.dim(` [${v.event_id}]`) : ""}`);
    }
    if (found.length > max) lines.push(c.dim(`    ...and ${found.length - max} more`));
  }

  lines.push("");
  lines.push(c.bold("Stats"));
  lines.push(`  bookings  ${stats.bookings.total} total; by status: ${pairs(stats.bookings.by_status)}; by route: ${pairs(stats.bookings.by_route)}; confirmed by: ${pairs(stats.bookings.confirmed_by)}`);
  lines.push(`  calls     ${stats.calls.placed} placed, ${stats.calls.ended} ended, ${stats.calls.transcribed} transcribed, ${stats.calls.disclosure_verified} disclosure verified, ${stats.calls.disclosure_missing} disclosure missing, ${stats.calls.tool_calls} tool calls`);
  lines.push(`  holds     ${stats.holds.placed} placed, ${stats.holds.converted} converted, ${stats.holds.released} released, ${stats.holds.expired} expired, ${stats.holds.active_at_end} active now`);
  lines.push(`  consents  ${stats.consents.recorded} recorded, ${stats.consents.revoked} revoked, ${stats.consents.active_at_end} active now`);
  lines.push(`  messages  ${stats.messages.sent} sent (${pairs(stats.messages.by_channel)}), ${stats.messages.received} received, ${stats.messages.not_sent} held back`);
  const median = stats.owner_reply_seconds.median;
  lines.push(`  owner reply time  ${median === null ? "no replies yet" : `median ${median.toFixed(1)}s over ${stats.owner_reply_seconds.samples} repl${stats.owner_reply_seconds.samples === 1 ? "y" : "ies"}`}`);
  lines.push("");
  const errors = result.violations.filter((v) => v.severity === "error").length;
  const warnings = result.violations.length - errors;
  lines.push(
    result.ok
      ? c.green(`All ${result.rules.length} rules hold${warnings ? ` (${warnings} warning${warnings === 1 ? "" : "s"})` : ""}.`)
      : c.red(`${errors} violation${errors === 1 ? "" : "s"} across ${result.rules.filter((r) => r.errors).length} rule(s).`),
  );
  return lines.join("\n");
}
