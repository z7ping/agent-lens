-- ADR-0024 / #617. New database, schema v1; never execute on a v1-v38 Legacy DB.
-- Session bodies, per-event facts, Evidence, and replication journals stay out of SQLite.
PRAGMA foreign_keys = ON;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE hosts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE agent_products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  vendor TEXT,
  homepage TEXT
);
CREATE TABLE agent_installations (
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
CREATE INDEX idx_slim_installations_host ON agent_installations(host_id);

CREATE TABLE runtime_profiles (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES agent_installations(id),
  native_profile_id TEXT NOT NULL,
  name TEXT,
  config_root TEXT,
  data_root TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (installation_id, native_profile_id)
);
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT,
  repository_identity TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id),
  project_id TEXT REFERENCES projects(id),
  path TEXT NOT NULL,
  repository_id TEXT,
  worktree_id TEXT
);
CREATE INDEX idx_slim_workspaces_project ON workspaces(project_id);

-- Lightweight association of a source-native session with existing user/project
-- metadata; not an Observation or a duplicate of the session transcript.
CREATE TABLE native_session_context (
  source_id TEXT NOT NULL,
  installation_id TEXT NOT NULL REFERENCES agent_installations(id),
  native_session_id TEXT NOT NULL,
  runtime_profile_id TEXT REFERENCES runtime_profiles(id),
  project_id TEXT REFERENCES projects(id),
  workspace_id TEXT REFERENCES workspaces(id),
  title_override TEXT,
  title_kind TEXT CHECK(title_kind IS NULL OR title_kind IN ('explicit','generated','unverified')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source_id, installation_id, native_session_id)
);
CREATE INDEX idx_slim_context_project ON native_session_context(project_id, updated_at DESC);

-- Exact native/archived location; only one row per location, never an event body.
CREATE TABLE native_session_catalog (
  source_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  location_kind TEXT NOT NULL CHECK(location_kind IN ('native','archive')),
  file_path TEXT NOT NULL,
  file_identity TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK(file_size >= 0),
  file_mtime_ms REAL NOT NULL,
  last_activity_at TEXT NOT NULL,
  title TEXT,
  updated_at TEXT NOT NULL,
  review_session_id TEXT,
  PRIMARY KEY (source_id, installation_id, native_session_id, location_kind)
);
CREATE INDEX idx_slim_catalog_activity
  ON native_session_catalog(last_activity_at DESC, source_id, installation_id, native_session_id);
CREATE INDEX idx_slim_catalog_review ON native_session_catalog(review_session_id, location_kind);

-- Same v38 metrics contract, without event-level data.
CREATE TABLE native_session_metrics (
  source_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  file_identity TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK(file_size >= 0),
  file_mtime_ms REAL NOT NULL,
  parser_version TEXT NOT NULL,
  projection_version TEXT NOT NULL,
  coverage TEXT NOT NULL CHECK(coverage IN ('complete','partial')),
  interaction_count INTEGER NOT NULL CHECK(interaction_count >= 0),
  tool_call_count INTEGER NOT NULL CHECK(tool_call_count >= 0),
  tool_result_count INTEGER NOT NULL CHECK(tool_result_count >= 0),
  tool_error_count INTEGER NOT NULL CHECK(tool_error_count >= 0),
  error_count INTEGER NOT NULL CHECK(error_count >= 0),
  input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens >= 0),
  computed_at TEXT NOT NULL,
  PRIMARY KEY(source_id, installation_id, native_session_id)
);
CREATE TABLE native_session_tool_metrics (
  source_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  native_tool_name TEXT NOT NULL,
  call_count INTEGER NOT NULL CHECK(call_count >= 0),
  result_count INTEGER NOT NULL CHECK(result_count >= 0),
  error_count INTEGER NOT NULL CHECK(error_count >= 0),
  total_duration_ms INTEGER NOT NULL CHECK(total_duration_ms >= 0),
  PRIMARY KEY(source_id, installation_id, native_session_id, native_tool_name),
  FOREIGN KEY(source_id, installation_id, native_session_id)
    REFERENCES native_session_metrics(source_id, installation_id, native_session_id)
    ON DELETE CASCADE
);
CREATE INDEX idx_slim_tool_names ON native_session_tool_metrics(native_tool_name);

-- Checkpoints are intentionally not bulk-copied from the old DB. Migration must
-- allowlist each scope because value_json may contain sensitive runtime payload.
CREATE TABLE source_checkpoints (
  scope TEXT NOT NULL,
  checkpoint_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(scope, checkpoint_key)
);
CREATE TRIGGER trg_slim_checkpoint_revision_guard
AFTER UPDATE OF value_json ON source_checkpoints
WHEN NEW.revision = OLD.revision
BEGIN
  UPDATE source_checkpoints SET revision = OLD.revision + 1
  WHERE scope = NEW.scope AND checkpoint_key = NEW.checkpoint_key AND revision = OLD.revision;
END;

CREATE TABLE asset_definitions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  display_name TEXT,
  upstream_identity TEXT
);
CREATE TABLE asset_bindings (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES asset_definitions(id),
  installation_id TEXT NOT NULL REFERENCES agent_installations(id),
  runtime_profile_id TEXT REFERENCES runtime_profiles(id),
  path TEXT,
  source TEXT,
  version TEXT,
  scope TEXT CHECK(scope IS NULL OR scope IN ('installation','user','project','workspace')),
  scope_root TEXT
);
CREATE INDEX idx_slim_asset_installation ON asset_bindings(installation_id, runtime_profile_id);
-- Only current boolean asset state. No historical observation/evidence chain.
CREATE TABLE asset_current_state (
  asset_binding_id TEXT NOT NULL REFERENCES asset_bindings(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  value TEXT NOT NULL CHECK(value IN ('true','false','unknown')),
  observed_at TEXT NOT NULL,
  PRIMARY KEY(asset_binding_id, state)
);

CREATE TABLE launchable_project_index (
  project_key TEXT PRIMARY KEY,
  project_id TEXT,
  project_name TEXT,
  repository_identity TEXT,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE launchable_workspace_index (
  project_key TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  validation_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK(validation_status IN ('unknown','valid','invalid')),
  validated_at TEXT,
  validated_path TEXT,
  PRIMARY KEY(project_key, workspace_id)
);
CREATE INDEX idx_slim_launchable_workspace ON launchable_workspace_index(workspace_id);

-- Scheduled reconstruction is allowed, not a transcript mirror.
CREATE TABLE maintenance_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  scope TEXT NOT NULL,
  priority INTEGER NOT NULL,
  state TEXT NOT NULL,
  progress_json TEXT,
  error_summary TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE(type, scope)
);
