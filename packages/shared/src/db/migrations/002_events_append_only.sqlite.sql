-- SQLite-only: refuse UPDATE and DELETE on the event log.
-- The Postgres equivalent is a BEFORE UPDATE OR DELETE trigger raising an exception,
-- or simply revoking UPDATE and DELETE on events from the application role.

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
