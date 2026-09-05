-- Parser replay drains one stale parser version at a time and paginates by (captured_at, id).
-- Keep the equality filters and ordering in one covering index prefix so large histories do not
-- fall back to idx_source_records_native + temporary B-Tree sorting.
CREATE INDEX IF NOT EXISTS idx_source_records_parser_replay
ON source_records(source_id, installation_id, parser_version, captured_at, id);
