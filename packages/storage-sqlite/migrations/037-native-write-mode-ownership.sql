-- A single durable ownership row for legacy or native-only writers.
-- Existing v36 native-only claims remain native-only after upgrade.
ALTER TABLE native_session_write_claims
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'native-only'
  CHECK (mode IN ('native-only', 'legacy'));
