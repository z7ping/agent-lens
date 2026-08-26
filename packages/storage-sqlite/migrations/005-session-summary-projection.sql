CREATE TABLE IF NOT EXISTS session_summary_projection (
  logical_session_id TEXT PRIMARY KEY REFERENCES logical_sessions(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL REFERENCES agent_installations(id),
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  observation_count INTEGER NOT NULL,
  user_message_count INTEGER NOT NULL,
  tool_count INTEGER NOT NULL,
  error_count INTEGER NOT NULL,
  first_user_payload TEXT,
  leading_kind TEXT,
  source_ids_json TEXT NOT NULL DEFAULT '[]',
  rebuilt_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_summary_projection_recent
ON session_summary_projection(ended_at DESC, logical_session_id ASC);

CREATE INDEX IF NOT EXISTS idx_session_summary_projection_installation_recent
ON session_summary_projection(installation_id, ended_at DESC, logical_session_id ASC);
