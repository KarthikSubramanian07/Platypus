-- Platypus schema v1.
-- Portable SQL: runs unchanged on SQLite (hackathon) and Postgres (production).
-- Timestamps are ISO-8601 UTC text, JSON columns are text, ids are ULIDs.
-- Tables are created in dependency order so every foreign key points backwards.

CREATE TABLE businesses (
  id                TEXT PRIMARY KEY,
  slug              TEXT NOT NULL UNIQUE,
  display_name      TEXT NOT NULL,
  trade             TEXT NOT NULL,
  phone_e164        TEXT NOT NULL UNIQUE,
  phone_is_real     BOOLEAN NOT NULL DEFAULT FALSE,
  text_number_e164  TEXT,
  short_code_prefix TEXT NOT NULL,
  services          TEXT NOT NULL DEFAULT '[]',
  address           TEXT,
  service_area      TEXT,
  hours             TEXT NOT NULL DEFAULT '{}',
  timezone          TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  channel_state     TEXT NOT NULL DEFAULT 'phone_only'
                    CHECK (channel_state IN ('phone_only', 'text_enabled', 'paused', 'unlisted')),
  channel_pref      TEXT CHECK (channel_pref IN ('imessage', 'whatsapp', 'dial')),
  do_not_call       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE bookings (
  id                    TEXT PRIMARY KEY,
  business_id           TEXT NOT NULL REFERENCES businesses(id),
  agent_id              TEXT NOT NULL,
  platform_id           TEXT,
  service               TEXT NOT NULL,
  details               TEXT,
  window_start          TEXT,
  window_end            TEXT,
  slot_start            TEXT,
  slot_end              TEXT,
  price_cents           INTEGER CHECK (price_cents IS NULL OR price_cents >= 0),
  status                TEXT NOT NULL
                        CHECK (status IN ('quote_pending', 'quoted', 'pending', 'countered', 'confirmed',
                                          'rescheduled', 'completed', 'no_show', 'disputed', 'declined',
                                          'expired', 'cancelled')),
  route                 TEXT CHECK (route IN ('darwin_act', 'call', 'text')),
  short_code            TEXT NOT NULL UNIQUE,
  quote_id              TEXT,
  requested_by          TEXT,
  notes                 TEXT,
  confirmation_evidence TEXT,
  confirmed_at          TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX bookings_business_status ON bookings (business_id, status);

CREATE TABLE holds (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  booking_id  TEXT REFERENCES bookings(id),
  slot_start  TEXT NOT NULL,
  slot_end    TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('active', 'converted', 'released', 'expired')),
  expires_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  CHECK (slot_end > slot_start)
);
CREATE INDEX holds_business_status ON holds (business_id, status);

CREATE TABLE calls (
  id               TEXT PRIMARY KEY,
  business_id      TEXT NOT NULL REFERENCES businesses(id),
  booking_id       TEXT REFERENCES bookings(id),
  dial_call_id     TEXT UNIQUE,
  direction        TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  to_e164          TEXT NOT NULL,
  status           TEXT NOT NULL,
  script_version   TEXT,
  started_at       TEXT,
  ended_at         TEXT,
  duration_seconds INTEGER,
  end_reason       TEXT,
  transcript       TEXT,
  transcript_turns TEXT,
  mined            TEXT,
  friction_score   REAL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX calls_business ON calls (business_id, created_at);

CREATE TABLE messages (
  id                  TEXT PRIMARY KEY,
  business_id         TEXT REFERENCES businesses(id),
  booking_id          TEXT REFERENCES bookings(id),
  direction           TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  channel             TEXT NOT NULL CHECK (channel IN ('sms', 'imessage', 'whatsapp', 'dial')),
  from_e164           TEXT NOT NULL,
  to_e164             TEXT NOT NULL,
  body                TEXT NOT NULL,
  provider_message_id TEXT UNIQUE,
  status              TEXT,
  reply_class         TEXT,
  classification      TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX messages_business ON messages (business_id, created_at);

-- Non-negotiable 3, enforced by the schema: a consent row cannot exist without
-- its evidence. A verbal yes needs the quoted sentence and the call; a JOIN
-- text needs the message.
CREATE TABLE consents (
  id                  TEXT PRIMARY KEY,
  business_id         TEXT NOT NULL REFERENCES businesses(id),
  channel             TEXT NOT NULL CHECK (channel IN ('sms', 'imessage', 'whatsapp', 'dial')),
  source              TEXT NOT NULL CHECK (source IN ('call', 'join_text')),
  quoted_sentence     TEXT,
  call_id             TEXT REFERENCES calls(id),
  transcript_turn_ref TEXT,
  message_id          TEXT REFERENCES messages(id),
  created_at          TEXT NOT NULL,
  revoked_at          TEXT,
  revoked_reason      TEXT,
  CHECK (
    (source = 'call' AND call_id IS NOT NULL AND quoted_sentence IS NOT NULL AND LENGTH(quoted_sentence) > 0)
    OR (source = 'join_text' AND message_id IS NOT NULL)
  )
);
CREATE INDEX consents_business ON consents (business_id, revoked_at);

CREATE TABLE rules (
  id                   TEXT PRIMARY KEY,
  business_id          TEXT NOT NULL REFERENCES businesses(id),
  source_text          TEXT NOT NULL,
  compiled_policy      TEXT NOT NULL DEFAULT '{}',
  status               TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'retired')),
  version              INTEGER NOT NULL DEFAULT 1,
  confirmed_message_id TEXT REFERENCES messages(id),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  CHECK (status <> 'active' OR confirmed_message_id IS NOT NULL)
);

CREATE TABLE idempotency_keys (
  key        TEXT NOT NULL,
  scope      TEXT NOT NULL,
  response   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

-- The append-only event log. Entity references are plain columns without
-- foreign keys so the log outlives any row it mentions.
CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  actor       TEXT NOT NULL CHECK (actor IN ('agent', 'owner', 'autopilot', 'voice', 'system')),
  business_id TEXT,
  booking_id  TEXT,
  call_id     TEXT,
  message_id  TEXT,
  consent_id  TEXT,
  hold_id     TEXT,
  payload     TEXT NOT NULL DEFAULT '{}',
  reason      TEXT,
  confidence  REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  created_at  TEXT NOT NULL
);
CREATE INDEX events_business ON events (business_id, id);
CREATE INDEX events_booking ON events (booking_id, id);
CREATE INDEX events_type ON events (type, id);
