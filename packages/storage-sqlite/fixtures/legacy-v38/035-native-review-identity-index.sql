-- ADR-0024 B: index synthetic Native Review identity without copying events.
-- Existing v34 Catalog rows remain intact (NULL review_session_id), as old
-- data migration is outside #617. Incremental Source observation fills the
-- derived identity on the next metadata-only UPSERT.
ALTER TABLE native_session_catalog ADD COLUMN review_session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_native_session_catalog_review_session
  ON native_session_catalog(review_session_id, location_kind);
