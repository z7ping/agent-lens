CREATE TABLE IF NOT EXISTS replication_canonical_changes (
  revision INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  origin_entity_id TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_replication_canonical_changes_entity
  ON replication_canonical_changes(entity_type, origin_entity_id, revision);

-- Seed existing Canonical state once so a newly paired Hub can bootstrap data
-- that predates this migration. Content remains in Canonical tables; this is
-- only a monotonic operational change index.
INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) SELECT 'AgentProduct', id FROM agent_products ORDER BY id;
INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) SELECT 'Host', id FROM hosts ORDER BY id;
INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) SELECT 'AgentInstallation', id FROM agent_installations ORDER BY id;
INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) SELECT 'RuntimeProfile', id FROM runtime_profiles ORDER BY id;
INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) SELECT 'Project', id FROM projects ORDER BY id;
INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) SELECT 'Workspace', id FROM workspaces ORDER BY id;
INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) SELECT 'LogicalSession', id FROM logical_sessions ORDER BY id;
INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) SELECT 'SourceSession', id FROM source_sessions ORDER BY id;
INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) SELECT 'SessionRelationship', id FROM session_relationships ORDER BY id;
INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) SELECT 'AgentActor', id FROM agent_actors ORDER BY id;
INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) SELECT 'SourceRecord', id FROM source_records ORDER BY id;
INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) SELECT 'CanonicalObservation', id FROM observations ORDER BY id;
INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) SELECT 'Evidence', id FROM evidence ORDER BY id;
INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) SELECT 'Coverage', id FROM coverage ORDER BY id;
INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) SELECT 'AssetDefinition', id FROM asset_definitions ORDER BY id;
INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) SELECT 'AssetBinding', id FROM asset_bindings ORDER BY id;
INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) SELECT 'AssetStateObservation', id FROM asset_state_observations ORDER BY id;
INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) SELECT 'ToolDefinition', id FROM tool_definitions ORDER BY id;

CREATE TRIGGER IF NOT EXISTS trg_rep_change_agent_products_insert AFTER INSERT ON agent_products BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('AgentProduct', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_agent_products_update AFTER UPDATE ON agent_products BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('AgentProduct', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_hosts_insert AFTER INSERT ON hosts BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('Host', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_hosts_update AFTER UPDATE ON hosts BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('Host', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_installations_insert AFTER INSERT ON agent_installations BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('AgentInstallation', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_installations_update AFTER UPDATE ON agent_installations BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('AgentInstallation', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_runtime_profiles_insert AFTER INSERT ON runtime_profiles BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('RuntimeProfile', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_runtime_profiles_update AFTER UPDATE ON runtime_profiles BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('RuntimeProfile', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_projects_insert AFTER INSERT ON projects BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('Project', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_projects_update AFTER UPDATE ON projects BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('Project', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_workspaces_insert AFTER INSERT ON workspaces BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('Workspace', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_workspaces_update AFTER UPDATE ON workspaces BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('Workspace', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_logical_sessions_insert AFTER INSERT ON logical_sessions BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('LogicalSession', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_logical_sessions_update AFTER UPDATE ON logical_sessions BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('LogicalSession', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_source_sessions_insert AFTER INSERT ON source_sessions BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('SourceSession', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_source_sessions_update AFTER UPDATE ON source_sessions BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('SourceSession', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_session_relationships_insert AFTER INSERT ON session_relationships BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('SessionRelationship', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_session_relationships_update AFTER UPDATE ON session_relationships BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('SessionRelationship', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_agent_actors_insert AFTER INSERT ON agent_actors BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('AgentActor', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_agent_actors_update AFTER UPDATE ON agent_actors BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('AgentActor', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_source_records_insert AFTER INSERT ON source_records BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('SourceRecord', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_source_records_update AFTER UPDATE ON source_records BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('SourceRecord', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_observations_insert AFTER INSERT ON observations BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('CanonicalObservation', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_observations_update AFTER UPDATE ON observations BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('CanonicalObservation', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_evidence_insert AFTER INSERT ON evidence BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('Evidence', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_evidence_update AFTER UPDATE ON evidence BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('Evidence', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_coverage_insert AFTER INSERT ON coverage BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('Coverage', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_coverage_update AFTER UPDATE ON coverage BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('Coverage', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_asset_definitions_insert AFTER INSERT ON asset_definitions BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('AssetDefinition', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_asset_definitions_update AFTER UPDATE ON asset_definitions BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('AssetDefinition', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_asset_bindings_insert AFTER INSERT ON asset_bindings BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('AssetBinding', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_asset_bindings_update AFTER UPDATE ON asset_bindings BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('AssetBinding', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_asset_states_insert AFTER INSERT ON asset_state_observations BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('AssetStateObservation', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_asset_states_update AFTER UPDATE ON asset_state_observations BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('AssetStateObservation', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_tools_insert AFTER INSERT ON tool_definitions BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('ToolDefinition', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_rep_change_tools_update AFTER UPDATE ON tool_definitions BEGIN
  INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('ToolDefinition', NEW.id);
END;
