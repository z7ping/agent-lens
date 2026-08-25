PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runtime_profiles (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES agent_installations(id),
  native_profile_id TEXT NOT NULL,
  name TEXT,
  config_root TEXT,
  data_root TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(installation_id, native_profile_id)
);
CREATE INDEX IF NOT EXISTS idx_runtime_profiles_installation ON runtime_profiles(installation_id);

ALTER TABLE logical_sessions ADD COLUMN runtime_profile_id TEXT REFERENCES runtime_profiles(id);
ALTER TABLE source_sessions ADD COLUMN runtime_profile_id TEXT REFERENCES runtime_profiles(id);
ALTER TABLE asset_bindings ADD COLUMN runtime_profile_id TEXT REFERENCES runtime_profiles(id);

CREATE INDEX IF NOT EXISTS idx_logical_sessions_runtime_profile ON logical_sessions(runtime_profile_id);
CREATE INDEX IF NOT EXISTS idx_source_sessions_runtime_profile ON source_sessions(runtime_profile_id);
CREATE INDEX IF NOT EXISTS idx_asset_bindings_runtime_profile ON asset_bindings(runtime_profile_id);

CREATE TABLE IF NOT EXISTS session_relationship_candidates (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  installation_id TEXT NOT NULL REFERENCES agent_installations(id),
  runtime_profile_id TEXT REFERENCES runtime_profiles(id),
  from_native_session_id TEXT NOT NULL,
  to_native_session_id TEXT NOT NULL,
  native_parent_event_id TEXT,
  relation_type TEXT,
  native_relation TEXT,
  confidence TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relationship_candidates_native
  ON session_relationship_candidates(source_id, installation_id, from_native_session_id, to_native_session_id);

CREATE TABLE IF NOT EXISTS source_runtime_status (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  installation_id TEXT NOT NULL REFERENCES agent_installations(id),
  runtime_profile_id TEXT REFERENCES runtime_profiles(id),
  stage TEXT NOT NULL,
  state TEXT NOT NULL,
  last_started_at TEXT,
  last_success_at TEXT,
  last_error_at TEXT,
  error_count INTEGER NOT NULL DEFAULT 0,
  last_error_summary TEXT,
  checkpoint_summary TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_source_runtime_status_identity
  ON source_runtime_status(source_id, installation_id, stage, IFNULL(runtime_profile_id, ''));
CREATE INDEX IF NOT EXISTS idx_source_runtime_status_state ON source_runtime_status(state);
