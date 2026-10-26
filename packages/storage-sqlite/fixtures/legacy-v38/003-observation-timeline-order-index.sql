CREATE INDEX IF NOT EXISTS idx_observations_timeline_order
ON observations(
  logical_session_id,
  COALESCE(occurred_at, captured_at),
  COALESCE(canonical_sequence, source_sequence, 9007199254740991),
  id
);
