-- ADR-0024 B: keep only re-computable numerical rollups.
-- The Source-owned native file / archive remains the ONLY session body.
-- Neither table has an event/payload/observation/evidence JSON column.
CREATE TABLE IF NOT EXISTS native_session_metrics (
  source_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  file_identity TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK(file_size >= 0),
  file_mtime_ms REAL NOT NULL,
  parser_version TEXT NOT NULL,
  projection_version TEXT NOT NULL,
  coverage TEXT NOT NULL CHECK(coverage IN ('complete','partial')),
  interaction_count INTEGER NOT NULL CHECK(interaction_count >= 0),
  tool_call_count INTEGER NOT NULL CHECK(tool_call_count >= 0),
  tool_result_count INTEGER NOT NULL CHECK(tool_result_count >= 0),
  tool_error_count INTEGER NOT NULL CHECK(tool_error_count >= 0),
  error_count INTEGER NOT NULL CHECK(error_count >= 0),
  input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens >= 0),
  computed_at TEXT NOT NULL,
  PRIMARY KEY(source_id,installation_id,native_session_id)
);

CREATE TABLE IF NOT EXISTS native_session_tool_metrics (
  source_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  native_tool_name TEXT NOT NULL,
  call_count INTEGER NOT NULL CHECK(call_count >= 0),
  result_count INTEGER NOT NULL CHECK(result_count >= 0),
  error_count INTEGER NOT NULL CHECK(error_count >= 0),
  total_duration_ms INTEGER NOT NULL CHECK(total_duration_ms >= 0),
  PRIMARY KEY(source_id,installation_id,native_session_id,native_tool_name),
  FOREIGN KEY(source_id,installation_id,native_session_id)
    REFERENCES native_session_metrics(source_id,installation_id,native_session_id)
    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_native_session_tool_metrics_name
  ON native_session_tool_metrics(native_tool_name);
