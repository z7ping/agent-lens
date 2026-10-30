-- Add observed-duration sample coverage without copying tool results.
ALTER TABLE native_session_tool_metrics
  ADD COLUMN duration_sample_count INTEGER NOT NULL DEFAULT 0 CHECK(duration_sample_count >= 0);
ALTER TABLE native_session_tool_metrics
  ADD COLUMN max_duration_ms INTEGER CHECK(max_duration_ms IS NULL OR max_duration_ms >= 0);
