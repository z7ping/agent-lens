-- ADR-0024 exception: searchable, rebuildable error facts only.
-- No prompts, tool arguments/output, stack dumps or Evidence bodies.
CREATE TABLE native_error_index (
  source_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  turn_ordinal INTEGER CHECK(turn_ordinal IS NULL OR turn_ordinal >= 1),
  native_event_id TEXT,
  tool_name TEXT,
  error_kind TEXT NOT NULL CHECK(error_kind IN ('tool','runtime')),
  error_code TEXT,
  summary TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  PRIMARY KEY (source_id, installation_id, native_session_id, event_key),
  FOREIGN KEY (source_id, installation_id, native_session_id)
    REFERENCES native_session_metrics(source_id, installation_id, native_session_id)
    ON DELETE CASCADE
);
CREATE INDEX idx_native_error_recent ON native_error_index(occurred_at DESC);
CREATE INDEX idx_native_error_tool ON native_error_index(source_id,tool_name,occurred_at DESC);
CREATE INDEX idx_native_error_fingerprint ON native_error_index(fingerprint,occurred_at DESC);
