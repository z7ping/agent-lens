CREATE TABLE IF NOT EXISTS replication_change_progress (
  stream_id TEXT NOT NULL REFERENCES replication_streams(stream_id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('bootstrap', 'incremental', 'reconcile')),
  entity_type TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  through_revision INTEGER NOT NULL CHECK (through_revision >= revision),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(stream_id, generation_id, phase, entity_type)
);

CREATE INDEX IF NOT EXISTS idx_replication_change_progress_stream
  ON replication_change_progress(stream_id, generation_id, phase);
