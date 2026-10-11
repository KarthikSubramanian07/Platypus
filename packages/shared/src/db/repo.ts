import type { Db } from "./index";
import type { Business, Call, Consent, Hold, Message, TableName, TableRows } from "./types";

export * from "./types";

/**
 * A deliberately thin data layer: plain SQL, one codec per table for JSON and
 * boolean columns, no ORM. State-changing callers (booking, consent, calls) are
 * responsible for emitting the matching event; nothing here changes state silently
 * on its own initiative.
 */
const CODECS: Record<TableName, { json: string[]; bool: string[] }> = {
  businesses: { json: ["services", "hours"], bool: ["phone_is_real", "do_not_call"] },
  bookings: { json: ["confirmation_evidence"], bool: [] },
  holds: { json: [], bool: [] },
  calls: { json: ["transcript_turns", "mined"], bool: [] },
  messages: { json: ["classification"], bool: [] },
  consents: { json: [], bool: [] },
  rules: { json: ["compiled_policy"], bool: [] },
  events: { json: ["payload"], bool: [] },
};

const IDENT = /^[a-z][a-z0-9_]*$/;

function encode(table: TableName, value: Record<string, unknown>): Record<string, unknown> {
  const { json, bool } = CODECS[table];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    if (!IDENT.test(k)) throw new Error(`Invalid column name: ${k}`);
    if (json.includes(k)) out[k] = v === null ? null : JSON.stringify(v);
    else if (bool.includes(k)) out[k] = v ? 1 : 0;
    else out[k] = v;
  }
  return out;
}

export function decode<T extends TableName>(table: T, row: Record<string, unknown> | undefined): TableRows[T] | undefined {
  if (!row) return undefined;
  const { json, bool } = CODECS[table];
  const out: Record<string, unknown> = { ...row };
  for (const k of json) if (typeof out[k] === "string") out[k] = JSON.parse(out[k] as string);
  for (const k of bool) out[k] = out[k] === 1 || out[k] === true;
  return out as unknown as TableRows[T];
}

export function insertRow<T extends TableName>(db: Db, table: T, value: TableRows[T]): TableRows[T] {
  const row = encode(table, value as unknown as Record<string, unknown>);
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`).run(row);
  return value;
}

export function updateRow<T extends Exclude<TableName, "events">>(
  db: Db,
  table: T,
  id: string,
  patch: Partial<TableRows[T]>,
): TableRows[T] {
  const row = encode(table, patch as Record<string, unknown>);
  delete row.id;
  const cols = Object.keys(row);
  if (cols.length > 0) {
    const result = db
      .prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = @${c}`).join(", ")} WHERE id = @__id`)
      .run({ ...row, __id: id });
    if (result.changes === 0) throw new Error(`${table} row not found: ${id}`);
  }
  const updated = getRow(db, table, id);
  if (!updated) throw new Error(`${table} row not found: ${id}`);
  return updated;
}

export function getRow<T extends TableName>(db: Db, table: T, id: string): TableRows[T] | undefined {
  return decode(table, db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined);
}

export function selectRows<T extends TableName>(db: Db, table: T, where = "1 = 1", params: unknown[] = [], orderBy = "id"): TableRows[T][] {
  return (db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY ${orderBy}`).all(...params) as Record<string, unknown>[]).map(
    (r) => decode(table, r)!,
  );
}

// ---- Convenience queries used across packages -------------------------------

export const getBusiness = (db: Db, id: string): Business | undefined => getRow(db, "businesses", id);

export const getBusinessBySlug = (db: Db, slug: string): Business | undefined =>
  selectRows(db, "businesses", "slug = ?", [slug])[0];

/** Finds the business a phone number belongs to: its listed line or its texting cell. */
export const getBusinessByNumber = (db: Db, e164: string): Business | undefined =>
  selectRows(db, "businesses", "phone_e164 = ? OR text_number_e164 = ?", [e164, e164])[0];

export const listBusinesses = (db: Db): Business[] => selectRows(db, "businesses", "1 = 1", [], "display_name");

export const getCallByDialId = (db: Db, dialCallId: string): Call | undefined =>
  selectRows(db, "calls", "dial_call_id = ?", [dialCallId])[0];

const LIVE_CALL_STATUSES = ["Queued", "Ringing", "In-Progress"];

/** The call currently live with this number, if any (used to authorize mid-call tools). */
export const getLiveCallForNumber = (db: Db, e164: string): Call | undefined =>
  selectRows(
    db,
    "calls",
    `to_e164 = ? AND status IN (${LIVE_CALL_STATUSES.map(() => "?").join(", ")})`,
    [e164, ...LIVE_CALL_STATUSES],
    "created_at DESC",
  )[0];

export const getMessageByProviderId = (db: Db, providerMessageId: string): Message | undefined =>
  selectRows(db, "messages", "provider_message_id = ?", [providerMessageId])[0];

export const getActiveConsent = (db: Db, businessId: string): Consent | undefined =>
  selectRows(db, "consents", "business_id = ? AND revoked_at IS NULL", [businessId], "created_at DESC")[0];

export const listActiveHolds = (db: Db, businessId: string, nowIso: string): Hold[] =>
  selectRows(db, "holds", "business_id = ? AND status = 'active' AND expires_at > ?", [businessId, nowIso]);
