-- Deep diagnostics are no longer part of /health, but explicit diagnostics still need
-- bounded recent-window scans on large databases.
CREATE INDEX IF NOT EXISTS idx_observations_captured_at
ON observations(captured_at);

CREATE INDEX IF NOT EXISTS idx_evidence_captured_at
ON evidence(captured_at);
