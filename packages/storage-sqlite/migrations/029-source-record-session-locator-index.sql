-- Resume/fork resolves native session locators by identity, never by scanning Observation/Evidence history.
CREATE INDEX IF NOT EXISTS idx_source_records_session_locator
ON source_records(source_id, installation_id, source_session_native_id, captured_at DESC, id DESC);
