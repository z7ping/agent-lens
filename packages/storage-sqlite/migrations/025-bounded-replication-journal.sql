CREATE TABLE IF NOT EXISTS replication_journal_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  high_water_revision INTEGER NOT NULL CHECK (high_water_revision >= 0),
  updated_at TEXT NOT NULL
);

INSERT INTO replication_journal_state(singleton, high_water_revision, updated_at)
VALUES (
  1,
  (SELECT COALESCE(MAX(revision), 0) FROM replication_canonical_changes),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
ON CONFLICT(singleton) DO UPDATE SET
  high_water_revision = MAX(replication_journal_state.high_water_revision, excluded.high_water_revision),
  updated_at = excluded.updated_at;

CREATE TRIGGER IF NOT EXISTS trg_replication_journal_high_water
AFTER INSERT ON replication_canonical_changes
BEGIN
  UPDATE replication_journal_state
  SET high_water_revision = MAX(high_water_revision, NEW.revision),
      updated_at = NEW.changed_at
  WHERE singleton = 1;
END;

CREATE TABLE IF NOT EXISTS replication_capture_watermarks (
  stream_id TEXT NOT NULL REFERENCES replication_streams(stream_id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  captured_revision INTEGER NOT NULL CHECK (captured_revision >= 0),
  dependency_state TEXT NOT NULL CHECK (dependency_state IN ('dependent', 'retired')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(stream_id, generation_id, entity_type)
);

CREATE INDEX IF NOT EXISTS idx_replication_capture_watermarks_state
  ON replication_capture_watermarks(dependency_state, captured_revision, stream_id);

-- Existing pre-Snapshot streams conservatively block GC until explicitly
-- re-bootstrapped or retired.
INSERT INTO replication_capture_watermarks(
  stream_id, generation_id, entity_type, captured_revision, dependency_state, updated_at
)
SELECT stream_id, generation_id, 'CanonicalObservation', 0, 'dependent', updated_at
FROM replication_streams
WHERE 1
ON CONFLICT(stream_id, generation_id, entity_type) DO NOTHING;
