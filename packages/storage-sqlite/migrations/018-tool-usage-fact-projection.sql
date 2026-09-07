CREATE TABLE IF NOT EXISTS tool_usage_fact_projection (
  observation_id TEXT PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL,
  logical_session_id TEXT NOT NULL,
  project_id TEXT,
  source_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  tool_name TEXT,
  call_id TEXT,
  skill_name TEXT,
  success INTEGER,
  duration_ms REAL
);

CREATE INDEX IF NOT EXISTS idx_tool_usage_fact_kind_time
ON tool_usage_fact_projection(kind, effective_at, observation_id);

CREATE INDEX IF NOT EXISTS idx_tool_usage_fact_source_tool_time
ON tool_usage_fact_projection(source_id, tool_name, effective_at, observation_id);

CREATE INDEX IF NOT EXISTS idx_tool_usage_fact_installation_time
ON tool_usage_fact_projection(installation_id, kind, effective_at, observation_id);

CREATE INDEX IF NOT EXISTS idx_tool_usage_fact_call
ON tool_usage_fact_projection(logical_session_id, call_id, kind, effective_at, observation_id);

-- Historical JSON backfill is deliberately not performed in schema migration.
-- New/changed tool observations stay correct through triggers; existing history
-- is materialized by the resumable background Maintenance Job after HTTP is ready.
CREATE TRIGGER IF NOT EXISTS trg_tool_usage_fact_observation_insert
AFTER INSERT ON observations
WHEN NEW.kind IN ('tool.call', 'tool.result')
BEGIN
  INSERT OR REPLACE INTO tool_usage_fact_projection(
    observation_id, installation_id, logical_session_id, project_id, source_id, product_id,
    kind, effective_at, tool_name, call_id, skill_name, success, duration_ms
  )
  SELECT
    NEW.id,
    NEW.installation_id,
    NEW.logical_session_id,
    NEW.project_id,
    ss.source_id,
    ai.product_id,
    NEW.kind,
    COALESCE(NEW.occurred_at, NEW.captured_at),
    COALESCE(
      CASE WHEN json_type(NEW.payload_json, '$.nativeToolName') = 'text' THEN NULLIF(json_extract(NEW.payload_json, '$.nativeToolName'), '') END,
      CASE WHEN json_type(NEW.payload_json, '$.toolName') = 'text' THEN NULLIF(json_extract(NEW.payload_json, '$.toolName'), '') END,
      CASE WHEN json_type(NEW.payload_json, '$.tool_name') = 'text' THEN NULLIF(json_extract(NEW.payload_json, '$.tool_name'), '') END,
      CASE WHEN json_type(NEW.payload_json, '$.name') = 'text' THEN NULLIF(json_extract(NEW.payload_json, '$.name'), '') END
    ),
    COALESCE(
      CASE WHEN json_type(NEW.payload_json, '$.callId') = 'text' THEN NULLIF(json_extract(NEW.payload_json, '$.callId'), '') END,
      CASE WHEN json_type(NEW.payload_json, '$.call_id') = 'text' THEN NULLIF(json_extract(NEW.payload_json, '$.call_id'), '') END,
      CASE WHEN json_type(NEW.payload_json, '$.toolUseId') = 'text' THEN NULLIF(json_extract(NEW.payload_json, '$.toolUseId'), '') END,
      CASE WHEN json_type(NEW.payload_json, '$.tool_use_id') = 'text' THEN NULLIF(json_extract(NEW.payload_json, '$.tool_use_id'), '') END
    ),
    COALESCE(
      CASE WHEN json_type(NEW.payload_json, '$.input.skill') = 'text' THEN NULLIF(json_extract(NEW.payload_json, '$.input.skill'), '') END,
      CASE WHEN json_type(NEW.payload_json, '$.input.name') = 'text' THEN NULLIF(json_extract(NEW.payload_json, '$.input.name'), '') END
    ),
    CASE
      WHEN json_type(NEW.payload_json, '$.success') IN ('true', 'false', 'integer')
        THEN json_extract(NEW.payload_json, '$.success')
    END,
    COALESCE(
      CASE WHEN json_type(NEW.payload_json, '$.durationMs') IN ('integer', 'real') THEN json_extract(NEW.payload_json, '$.durationMs') END,
      CASE WHEN json_type(NEW.payload_json, '$.duration_ms') IN ('integer', 'real') THEN json_extract(NEW.payload_json, '$.duration_ms') END
    )
  FROM source_sessions ss
  JOIN agent_installations ai ON ai.id = NEW.installation_id
  WHERE ss.id = NEW.source_session_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_tool_usage_fact_observation_update
AFTER UPDATE OF installation_id, logical_session_id, project_id, source_session_id, kind, occurred_at, captured_at, payload_json ON observations
BEGIN
  DELETE FROM tool_usage_fact_projection WHERE observation_id = NEW.id;

  INSERT OR REPLACE INTO tool_usage_fact_projection(
    observation_id, installation_id, logical_session_id, project_id, source_id, product_id,
    kind, effective_at, tool_name, call_id, skill_name, success, duration_ms
  )
  SELECT
    NEW.id,
    NEW.installation_id,
    NEW.logical_session_id,
    NEW.project_id,
    ss.source_id,
    ai.product_id,
    NEW.kind,
    COALESCE(NEW.occurred_at, NEW.captured_at),
    COALESCE(
      CASE WHEN json_type(NEW.payload_json, '$.nativeToolName') = 'text' THEN NULLIF(json_extract(NEW.payload_json, '$.nativeToolName'), '') END,
      CASE WHEN json_type(NEW.payload_json, '$.toolName') = 'text' THEN NULLIF(json_extract(NEW.payload_json, '$.toolName'), '') END,
      CASE WHEN json_type(NEW.payload_json, '$.tool_name') = 'text' THEN NULLIF(json_extract(NEW.payload_json, '$.tool_name'), '') END,
      CASE WHEN json_type(NEW.payload_json, '$.name') = 'text' THEN NULLIF(json_extract(NEW.payload_json, '$.name'), '') END
    ),
    COALESCE(
      CASE WHEN json_type(NEW.payload_json, '$.callId') = 'text' THEN NULLIF(json_extract(NEW.payload_json, '$.callId'), '') END,
      CASE WHEN json_type(NEW.payload_json, '$.call_id') = 'text' THEN NULLIF(json_extract(NEW.payload_json, '$.call_id'), '') END,
      CASE WHEN json_type(NEW.payload_json, '$.toolUseId') = 'text' THEN NULLIF(json_extract(NEW.payload_json, '$.toolUseId'), '') END,
      CASE WHEN json_type(NEW.payload_json, '$.tool_use_id') = 'text' THEN NULLIF(json_extract(NEW.payload_json, '$.tool_use_id'), '') END
    ),
    COALESCE(
      CASE WHEN json_type(NEW.payload_json, '$.input.skill') = 'text' THEN NULLIF(json_extract(NEW.payload_json, '$.input.skill'), '') END,
      CASE WHEN json_type(NEW.payload_json, '$.input.name') = 'text' THEN NULLIF(json_extract(NEW.payload_json, '$.input.name'), '') END
    ),
    CASE
      WHEN json_type(NEW.payload_json, '$.success') IN ('true', 'false', 'integer')
        THEN json_extract(NEW.payload_json, '$.success')
    END,
    COALESCE(
      CASE WHEN json_type(NEW.payload_json, '$.durationMs') IN ('integer', 'real') THEN json_extract(NEW.payload_json, '$.durationMs') END,
      CASE WHEN json_type(NEW.payload_json, '$.duration_ms') IN ('integer', 'real') THEN json_extract(NEW.payload_json, '$.duration_ms') END
    )
  FROM source_sessions ss
  JOIN agent_installations ai ON ai.id = NEW.installation_id
  WHERE ss.id = NEW.source_session_id
    AND NEW.kind IN ('tool.call', 'tool.result');
END;
