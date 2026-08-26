CREATE INDEX IF NOT EXISTS idx_observations_kind_timeline_order
ON observations(
  kind,
  COALESCE(occurred_at, captured_at),
  COALESCE(canonical_sequence, source_sequence, 9007199254740991),
  id
);

CREATE INDEX IF NOT EXISTS idx_observations_installation_kind_timeline_order
ON observations(
  installation_id,
  kind,
  COALESCE(occurred_at, captured_at),
  COALESCE(canonical_sequence, source_sequence, 9007199254740991),
  id
);
