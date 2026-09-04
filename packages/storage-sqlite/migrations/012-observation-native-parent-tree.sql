ALTER TABLE observations ADD COLUMN native_event_id TEXT;
ALTER TABLE observations ADD COLUMN native_parent_event_id TEXT;
ALTER TABLE observations ADD COLUMN parent_observation_id TEXT REFERENCES observations(id);

CREATE INDEX IF NOT EXISTS idx_observations_source_native_event
  ON observations(source_session_id, native_event_id);
CREATE INDEX IF NOT EXISTS idx_observations_source_native_parent
  ON observations(source_session_id, native_parent_event_id);
CREATE INDEX IF NOT EXISTS idx_observations_parent
  ON observations(parent_observation_id);
