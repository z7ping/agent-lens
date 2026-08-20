PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  vendor TEXT,
  homepage TEXT
);

CREATE TABLE IF NOT EXISTS agent_installations (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id),
  product_id TEXT NOT NULL REFERENCES agent_products(id),
  version TEXT,
  executable TEXT,
  config_root TEXT,
  data_root TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_installations_product ON agent_installations(product_id);
CREATE INDEX IF NOT EXISTS idx_installations_host ON agent_installations(host_id);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT,
  repository_identity TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_repository_identity ON projects(repository_identity);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id),
  project_id TEXT REFERENCES projects(id),
  path TEXT NOT NULL,
  repository_id TEXT,
  worktree_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_workspaces_host_path ON workspaces(host_id, path);
CREATE INDEX IF NOT EXISTS idx_workspaces_project ON workspaces(project_id);

CREATE TABLE IF NOT EXISTS logical_sessions (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES agent_installations(id),
  project_id TEXT REFERENCES projects(id),
  workspace_id TEXT REFERENCES workspaces(id),
  title TEXT,
  started_at TEXT,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_logical_sessions_installation ON logical_sessions(installation_id);
CREATE INDEX IF NOT EXISTS idx_logical_sessions_project ON logical_sessions(project_id);

CREATE TABLE IF NOT EXISTS source_sessions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  installation_id TEXT NOT NULL REFERENCES agent_installations(id),
  native_session_id TEXT NOT NULL,
  logical_session_id TEXT REFERENCES logical_sessions(id),
  native_parent_session_id TEXT,
  UNIQUE(source_id, installation_id, native_session_id)
);
CREATE INDEX IF NOT EXISTS idx_source_sessions_logical ON source_sessions(logical_session_id);

CREATE TABLE IF NOT EXISTS session_relationships (
  id TEXT PRIMARY KEY,
  from_session_id TEXT NOT NULL REFERENCES logical_sessions(id),
  to_session_id TEXT NOT NULL REFERENCES logical_sessions(id),
  type TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  confidence TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_relationships_from ON session_relationships(from_session_id);
CREATE INDEX IF NOT EXISTS idx_session_relationships_to ON session_relationships(to_session_id);

CREATE TABLE IF NOT EXISTS agent_actors (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES agent_installations(id),
  logical_session_id TEXT REFERENCES logical_sessions(id),
  parent_actor_id TEXT REFERENCES agent_actors(id),
  role TEXT NOT NULL,
  native_actor_id TEXT,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_agent_actors_session ON agent_actors(logical_session_id);
CREATE INDEX IF NOT EXISTS idx_agent_actors_native ON agent_actors(installation_id, native_actor_id);

CREATE TABLE IF NOT EXISTS interactions (
  id TEXT PRIMARY KEY,
  logical_session_id TEXT NOT NULL REFERENCES logical_sessions(id),
  ordinal INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  start_observation_id TEXT,
  end_observation_id TEXT,
  started_at TEXT,
  ended_at TEXT,
  UNIQUE(logical_session_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_interactions_session ON interactions(logical_session_id, ordinal);

CREATE TABLE IF NOT EXISTS source_records (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  installation_id TEXT NOT NULL REFERENCES agent_installations(id),
  source_session_native_id TEXT,
  native_type TEXT NOT NULL,
  native_id TEXT,
  source_sequence INTEGER,
  occurred_at TEXT,
  captured_at TEXT NOT NULL,
  locator_json TEXT NOT NULL,
  fingerprint TEXT,
  payload_json TEXT NOT NULL,
  parser_version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_records_session ON source_records(source_id, source_session_native_id);
CREATE INDEX IF NOT EXISTS idx_source_records_native ON source_records(source_id, installation_id, native_id);
CREATE INDEX IF NOT EXISTS idx_source_records_captured ON source_records(captured_at);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id),
  installation_id TEXT NOT NULL REFERENCES agent_installations(id),
  project_id TEXT REFERENCES projects(id),
  workspace_id TEXT REFERENCES workspaces(id),
  logical_session_id TEXT NOT NULL REFERENCES logical_sessions(id),
  source_session_id TEXT NOT NULL REFERENCES source_sessions(id),
  interaction_id TEXT REFERENCES interactions(id),
  actor_id TEXT REFERENCES agent_actors(id),
  kind TEXT NOT NULL,
  source_sequence INTEGER,
  canonical_sequence INTEGER,
  occurred_at TEXT,
  captured_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(logical_session_id, canonical_sequence);
CREATE INDEX IF NOT EXISTS idx_observations_installation_time ON observations(installation_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_observations_kind_time ON observations(kind, occurred_at);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  capture_method TEXT NOT NULL,
  derivation TEXT NOT NULL,
  confidence TEXT NOT NULL,
  source_record_id TEXT REFERENCES source_records(id),
  source_locator_json TEXT,
  parser_version TEXT,
  event_time TEXT,
  captured_at TEXT NOT NULL,
  missing_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_evidence_source_record ON evidence(source_record_id);

CREATE TABLE IF NOT EXISTS observation_evidence (
  observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  PRIMARY KEY(observation_id, evidence_id)
);
CREATE INDEX IF NOT EXISTS idx_observation_evidence_evidence ON observation_evidence(evidence_id);

CREATE TABLE IF NOT EXISTS coverage (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  from_time TEXT,
  to_time TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_coverage_subject ON coverage(subject_type, subject_id, capability);
CREATE INDEX IF NOT EXISTS idx_coverage_window ON coverage(from_time, to_time);

CREATE TABLE IF NOT EXISTS asset_definitions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  display_name TEXT,
  upstream_identity TEXT
);
CREATE INDEX IF NOT EXISTS idx_asset_definitions_identity ON asset_definitions(type, canonical_name);

CREATE TABLE IF NOT EXISTS asset_bindings (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES asset_definitions(id),
  installation_id TEXT NOT NULL REFERENCES agent_installations(id),
  path TEXT,
  source TEXT,
  version TEXT
);
CREATE INDEX IF NOT EXISTS idx_asset_bindings_installation ON asset_bindings(installation_id);
CREATE INDEX IF NOT EXISTS idx_asset_bindings_asset ON asset_bindings(asset_id);

CREATE TABLE IF NOT EXISTS asset_state_observations (
  id TEXT PRIMARY KEY,
  asset_binding_id TEXT NOT NULL REFERENCES asset_bindings(id),
  state TEXT NOT NULL,
  value TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_asset_state_binding_time ON asset_state_observations(asset_binding_id, observed_at);

CREATE TABLE IF NOT EXISTS tool_definitions (
  id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  display_name TEXT,
  source_type TEXT NOT NULL,
  asset_definition_id TEXT REFERENCES asset_definitions(id),
  installation_id TEXT REFERENCES agent_installations(id),
  schema_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_definitions_installation ON tool_definitions(installation_id, canonical_name);
CREATE INDEX IF NOT EXISTS idx_tool_definitions_asset ON tool_definitions(asset_definition_id);
