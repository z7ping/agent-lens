CREATE TABLE IF NOT EXISTS unknown_observation_projection (
  observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  native_type TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY(observation_id, source_id, native_type)
);

CREATE INDEX IF NOT EXISTS idx_unknown_observation_projection_group
ON unknown_observation_projection(source_id, native_type, last_seen_at DESC, observation_id);

-- Historical backfill is deliberately not performed in schema migration.
-- New/changed rows stay correct through triggers; existing history is rebuilt by
-- the resumable background Maintenance Job after the HTTP control plane is ready.
CREATE TRIGGER IF NOT EXISTS trg_unknown_projection_observation_update
AFTER UPDATE OF kind, occurred_at, captured_at ON observations
BEGIN
  DELETE FROM unknown_observation_projection
  WHERE observation_id = NEW.id;

  INSERT OR IGNORE INTO unknown_observation_projection(
    observation_id, source_id, native_type, last_seen_at
  )
  SELECT DISTINCT
    NEW.id,
    sr.source_id,
    sr.native_type,
    COALESCE(NEW.occurred_at, NEW.captured_at)
  FROM observation_evidence oe
  JOIN evidence e ON e.id = oe.evidence_id
  JOIN source_records sr ON sr.id = e.source_record_id
  WHERE oe.observation_id = NEW.id
    AND NEW.kind = 'unknown';
END;

CREATE TRIGGER IF NOT EXISTS trg_unknown_projection_observation_delete
AFTER DELETE ON observations
BEGIN
  DELETE FROM unknown_observation_projection
  WHERE observation_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_unknown_projection_evidence_link_insert
AFTER INSERT ON observation_evidence
BEGIN
  INSERT OR IGNORE INTO unknown_observation_projection(
    observation_id, source_id, native_type, last_seen_at
  )
  SELECT
    o.id,
    sr.source_id,
    sr.native_type,
    COALESCE(o.occurred_at, o.captured_at)
  FROM observations o
  JOIN evidence e ON e.id = NEW.evidence_id
  JOIN source_records sr ON sr.id = e.source_record_id
  WHERE o.id = NEW.observation_id
    AND o.kind = 'unknown';
END;

CREATE TRIGGER IF NOT EXISTS trg_unknown_projection_evidence_link_delete
AFTER DELETE ON observation_evidence
BEGIN
  DELETE FROM unknown_observation_projection
  WHERE observation_id = OLD.observation_id
    AND NOT EXISTS (
      SELECT 1
      FROM observation_evidence oe
      JOIN evidence e ON e.id = oe.evidence_id
      JOIN source_records sr ON sr.id = e.source_record_id
      WHERE oe.observation_id = OLD.observation_id
        AND sr.source_id = unknown_observation_projection.source_id
        AND sr.native_type = unknown_observation_projection.native_type
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_unknown_projection_evidence_source_update
AFTER UPDATE OF source_record_id ON evidence
BEGIN
  DELETE FROM unknown_observation_projection
  WHERE observation_id IN (
    SELECT observation_id FROM observation_evidence WHERE evidence_id = NEW.id
  );

  INSERT OR IGNORE INTO unknown_observation_projection(
    observation_id, source_id, native_type, last_seen_at
  )
  SELECT DISTINCT
    o.id,
    sr.source_id,
    sr.native_type,
    COALESCE(o.occurred_at, o.captured_at)
  FROM observation_evidence target
  JOIN observations o ON o.id = target.observation_id
  JOIN observation_evidence oe ON oe.observation_id = o.id
  JOIN evidence e ON e.id = oe.evidence_id
  JOIN source_records sr ON sr.id = e.source_record_id
  WHERE target.evidence_id = NEW.id
    AND o.kind = 'unknown';
END;
