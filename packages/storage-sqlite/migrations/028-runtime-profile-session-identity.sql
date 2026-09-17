PRAGMA defer_foreign_keys = ON;

CREATE TABLE source_sessions_v28 (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  installation_id TEXT NOT NULL REFERENCES agent_installations(id),
  native_session_id TEXT NOT NULL,
  logical_session_id TEXT REFERENCES logical_sessions(id),
  native_parent_session_id TEXT,
  runtime_profile_id TEXT REFERENCES runtime_profiles(id)
);

INSERT INTO source_sessions_v28(
  id,
  source_id,
  installation_id,
  native_session_id,
  logical_session_id,
  native_parent_session_id,
  runtime_profile_id
)
SELECT
  id,
  source_id,
  installation_id,
  native_session_id,
  logical_session_id,
  native_parent_session_id,
  runtime_profile_id
FROM source_sessions;

DROP TABLE source_sessions;
ALTER TABLE source_sessions_v28 RENAME TO source_sessions;

CREATE INDEX idx_source_sessions_logical ON source_sessions(logical_session_id);
CREATE INDEX idx_source_sessions_runtime_profile ON source_sessions(runtime_profile_id);
CREATE UNIQUE INDEX idx_source_sessions_profile_identity
  ON source_sessions(
    source_id,
    installation_id,
    native_session_id,
    IFNULL(runtime_profile_id, '')
  );
