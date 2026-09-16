CREATE TABLE IF NOT EXISTS replication_stream_authorizations (
  stream_id TEXT PRIMARY KEY REFERENCES replication_streams(stream_id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL,
  policy_mode TEXT NOT NULL CHECK (policy_mode IN ('metadata-only', 'redacted', 'full')),
  policy_revision TEXT NOT NULL,
  history_mode TEXT NOT NULL CHECK (history_mode IN ('include-existing', 'from-now')),
  history_revision TEXT NOT NULL,
  boundary_captured_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (history_mode = 'include-existing' AND boundary_captured_at IS NULL)
    OR
    (history_mode = 'from-now' AND boundary_captured_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS replication_reconciliation_cycles (
  stream_id TEXT NOT NULL REFERENCES replication_streams(stream_id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  cycle INTEGER NOT NULL CHECK (cycle >= 0),
  status TEXT NOT NULL CHECK (status IN ('idle', 'running')),
  through_revision INTEGER NOT NULL CHECK (through_revision >= 0),
  started_at TEXT,
  completed_at TEXT,
  next_due_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(stream_id, generation_id, entity_type)
);

CREATE INDEX IF NOT EXISTS idx_replication_reconciliation_cycles_due
  ON replication_reconciliation_cycles(status, next_due_at, stream_id);

-- Existing streams become conservatively dependent on every entity type that
-- the CanonicalObservation root graph can reconstruct. They remain at revision
-- zero until a full periodic reconciliation proves current-state coverage.
INSERT INTO replication_capture_watermarks(
  stream_id, generation_id, entity_type, captured_revision, dependency_state, updated_at
)
SELECT s.stream_id, s.generation_id, entity_type, 0, 'dependent', s.updated_at
FROM replication_streams s
CROSS JOIN (
  SELECT 'AgentProduct' AS entity_type
  UNION ALL SELECT 'Host'
  UNION ALL SELECT 'AgentInstallation'
  UNION ALL SELECT 'RuntimeProfile'
  UNION ALL SELECT 'Project'
  UNION ALL SELECT 'Workspace'
  UNION ALL SELECT 'LogicalSession'
  UNION ALL SELECT 'SourceSession'
  UNION ALL SELECT 'AgentActor'
  UNION ALL SELECT 'SourceRecord'
  UNION ALL SELECT 'Evidence'
  UNION ALL SELECT 'CanonicalObservation'
)
ON CONFLICT(stream_id, generation_id, entity_type) DO NOTHING;
