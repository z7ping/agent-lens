-- ADR-0024 B: metadata-only native/archived session locations.
-- No SourceRecord/Observation/Evidence payload or event-level duplication.
-- Old tables remain untouched. Missing files do not cascade-delete catalog rows.
CREATE TABLE IF NOT EXISTS native_session_catalog (
  source_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  location_kind TEXT NOT NULL CHECK (location_kind IN ('native', 'archive')),
  file_path TEXT NOT NULL,
  file_identity TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK (file_size >= 0),
  file_mtime_ms REAL NOT NULL,
  last_activity_at TEXT NOT NULL,
  title TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source_id, installation_id, native_session_id, location_kind)
);
CREATE INDEX IF NOT EXISTS idx_native_session_catalog_activity
  ON native_session_catalog (last_activity_at DESC, source_id, installation_id, native_session_id);
CREATE INDEX IF NOT EXISTS idx_native_session_catalog_installation
  ON native_session_catalog (installation_id, source_id, last_activity_at DESC);
