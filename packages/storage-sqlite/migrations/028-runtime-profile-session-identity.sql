PRAGMA legacy_alter_table = ON;

-- Schema v4 added runtime_profile_id to source_sessions, but the v1 table-level
-- UNIQUE(source_id, installation_id, native_session_id) still collapsed the same
-- native session id across RuntimeProfiles. Rebuild the table so legacy rows keep
-- their old uniqueness while profiled rows are unique within one profile.
DROP TRIGGER IF EXISTS trg_rep_change_source_sessions_insert;
DROP TRIGGER IF EXISTS trg_rep_change_source_sessions_update;

ALTER TABLE source_sessions RENAME TO source_sessions_v27;

CREATE TABLE source_sessions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  installation_id TEXT NOT NULL REFERENCES agent_installations(id),
  runtime_profile_id TEXT REFERENCES runtime_profiles(id),
  native_session_id TEXT NOT NULL,
  logical_session_id TEXT REFERENCES logical_sessions(id),
  native_parent_session_id TEXT
);

INSERT INTO source_sessions(
  id,
  source_id,
  installation_id,
  runtime_profile_id,
  native_session_id,
  logical_session_id,
  native_parent_session_id
)
SELECT
  id,
  source_id,
  installation_id,
  runtime_profile_id,
  native_session_id,
  logical_session_id,
  native_parent_session_id
FROM source_sessions_v27;

DROP TABLE source_sessions_v27;

CREATE INDEX idx_source_sessions_logical
  ON source_sessions(logical_session_id);
CREATE INDEX idx_source_sessions_runtime_profile
  ON source_sessions(runtime_profile_id);
CREATE UNIQUE INDEX idx_source_sessions_identity_legacy
  ON source_sessions(source_id, installation_id, native_session_id)
  WHERE runtime_profile_id IS NULL;
CREATE UNIQUE INDEX idx_source_sessions_identity_profile
  ON source_sessions(source_id, installation_id, runtime_profile_id, native_session_id)
  WHERE runtime_profile_id IS NOT NULL;

-- The v8 replication journal owns these triggers. Recreate them on the rebuilt
-- canonical table so profile-aware session writes remain visible to replication.
CREATE TRIGGER trg_rep_change_source_sessions_insert AFTER INSERT ON source_sessions BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('SourceSession', NEW.id);
END;
CREATE TRIGGER trg_rep_change_source_sessions_update AFTER UPDATE ON source_sessions BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('SourceSession', NEW.id);
END;

PRAGMA legacy_alter_table = OFF;
