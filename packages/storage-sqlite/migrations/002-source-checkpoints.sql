CREATE TABLE IF NOT EXISTS source_checkpoints (
  scope TEXT NOT NULL,
  checkpoint_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(scope, checkpoint_key)
);

CREATE INDEX IF NOT EXISTS idx_source_checkpoints_scope
  ON source_checkpoints(scope, updated_at);
