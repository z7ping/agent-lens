CREATE TABLE IF NOT EXISTS replication_entity_heads (
  entity_type TEXT NOT NULL,
  origin_entity_id TEXT NOT NULL,
  first_revision INTEGER NOT NULL CHECK (first_revision >= 0),
  first_changed_at TEXT NOT NULL,
  latest_revision INTEGER NOT NULL CHECK (latest_revision >= first_revision),
  latest_changed_at TEXT NOT NULL,
  PRIMARY KEY(entity_type, origin_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_replication_entity_heads_revision
  ON replication_entity_heads(entity_type, latest_revision, origin_entity_id);

CREATE INDEX IF NOT EXISTS idx_replication_entity_heads_changed_at
  ON replication_entity_heads(entity_type, latest_changed_at, origin_entity_id);

-- ADR-0010 keeps destructive automatic journal GC disabled while proposed, so
-- every current canonical row seeded by v8 is still represented in the journal.
-- Collapse that history to one bounded head row per replicated entity.
INSERT INTO replication_entity_heads(
  entity_type, origin_entity_id,
  first_revision, first_changed_at,
  latest_revision, latest_changed_at
)
SELECT latest_row.entity_type,
       latest_row.origin_entity_id,
       first_row.revision,
       first_row.changed_at,
       latest_row.revision,
       latest_row.changed_at
FROM (
  SELECT entity_type, origin_entity_id,
         MIN(revision) AS first_revision,
         MAX(revision) AS latest_revision
  FROM replication_canonical_changes
  GROUP BY entity_type, origin_entity_id
) bounds
JOIN replication_canonical_changes first_row
  ON first_row.entity_type = bounds.entity_type
 AND first_row.origin_entity_id = bounds.origin_entity_id
 AND first_row.revision = bounds.first_revision
JOIN replication_canonical_changes latest_row
  ON latest_row.entity_type = bounds.entity_type
 AND latest_row.origin_entity_id = bounds.origin_entity_id
 AND latest_row.revision = bounds.latest_revision
WHERE 1
ON CONFLICT(entity_type, origin_entity_id) DO UPDATE SET
  latest_revision = excluded.latest_revision,
  latest_changed_at = excluded.latest_changed_at
WHERE excluded.latest_revision > replication_entity_heads.latest_revision;

CREATE TRIGGER IF NOT EXISTS trg_replication_entity_head_after_change
AFTER INSERT ON replication_canonical_changes
BEGIN
  INSERT INTO replication_entity_heads(
    entity_type, origin_entity_id,
    first_revision, first_changed_at,
    latest_revision, latest_changed_at
  ) VALUES (
    NEW.entity_type, NEW.origin_entity_id,
    NEW.revision, NEW.changed_at,
    NEW.revision, NEW.changed_at
  )
  ON CONFLICT(entity_type, origin_entity_id) DO UPDATE SET
    latest_revision = excluded.latest_revision,
    latest_changed_at = excluded.latest_changed_at
  WHERE excluded.latest_revision > replication_entity_heads.latest_revision;
END;

-- v27 makes the final contract self-contained: every existing Stream
-- conservatively depends on all 18 replicated R1 entity roots until each Root
-- Snapshot/Reconciliation proves coverage. ON CONFLICT keeps upgrades idempotent.
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
  UNION ALL SELECT 'SessionRelationship'
  UNION ALL SELECT 'AgentActor'
  UNION ALL SELECT 'SourceRecord'
  UNION ALL SELECT 'Evidence'
  UNION ALL SELECT 'CanonicalObservation'
  UNION ALL SELECT 'Coverage'
  UNION ALL SELECT 'AssetDefinition'
  UNION ALL SELECT 'AssetBinding'
  UNION ALL SELECT 'AssetStateObservation'
  UNION ALL SELECT 'ToolDefinition'
)
WHERE 1
ON CONFLICT(stream_id, generation_id, entity_type) DO NOTHING;
