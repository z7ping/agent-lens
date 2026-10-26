CREATE TABLE IF NOT EXISTS replication_bootstrap_generations (
  stream_id TEXT NOT NULL REFERENCES replication_streams(stream_id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('staged', 'snapshot', 'delta', 'reconcile', 'active')),
  policy_revision TEXT NOT NULL,
  history_revision TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(stream_id, generation_id, entity_type)
);

CREATE INDEX IF NOT EXISTS idx_replication_bootstrap_generation_stage
  ON replication_bootstrap_generations(stage, stream_id, generation_id);
