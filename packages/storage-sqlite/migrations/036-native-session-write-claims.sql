-- ADR-0024 B: durable, per-source-session native-only writer claim.
-- No record payload, events or Evidence are copied. This table does NOT switch
-- ingest behavior by itself; consumers must be migrated before activation.
CREATE TABLE IF NOT EXISTS native_session_write_claims (
  source_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  PRIMARY KEY(source_id,installation_id,native_session_id)
);
