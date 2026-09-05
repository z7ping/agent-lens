ALTER TABLE source_records ADD COLUMN payload_encoding TEXT NOT NULL DEFAULT 'json';
ALTER TABLE source_records ADD COLUMN payload_blob BLOB;

-- Legacy rows stay as payload_encoding=json until cooperative maintenance processes them.
-- New repository writes use plain-json or gzip-json immediately.
CREATE INDEX IF NOT EXISTS idx_source_records_payload_compression_pending
ON source_records(captured_at, id)
WHERE payload_encoding = 'json';
