CREATE TABLE IF NOT EXISTS replication_snapshot_bootstrap_progress (
  stream_id TEXT NOT NULL REFERENCES replication_streams(stream_id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  baseline_revision INTEGER NOT NULL CHECK (baseline_revision >= 0),
  policy_revision TEXT NOT NULL,
  history_revision TEXT NOT NULL,
  cursor TEXT,
  snapshot_complete INTEGER NOT NULL DEFAULT 0 CHECK (snapshot_complete IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(stream_id, generation_id, entity_type)
);

CREATE INDEX IF NOT EXISTS idx_replication_snapshot_bootstrap_stream
  ON replication_snapshot_bootstrap_progress(stream_id, generation_id);
