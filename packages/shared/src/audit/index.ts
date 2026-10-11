/**
 * The non-negotiables, machine-checked: a pure auditor over the append-only event log.
 *
 *   import { auditEventLog, formatAuditReport } from "@platypus/shared/audit";
 *   const result = auditEventLog(listEvents(db, { limit: 10_000 }));
 *   if (!result.ok) console.log(formatAuditReport(result));
 */
export * from "./rules";
export * from "./audit";
export * from "./report";
