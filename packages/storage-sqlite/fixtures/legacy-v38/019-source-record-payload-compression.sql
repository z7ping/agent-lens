ALTER TABLE source_records ADD COLUMN payload_encoding TEXT NOT NULL DEFAULT 'json';
ALTER TABLE source_records ADD COLUMN payload_blob BLOB;

-- Legacy rows stay as payload_encoding=json until cooperative maintenance processes them.
-- New repository writes use plain-json or gzip-json immediately.
-- Legacy compression walks the existing SourceRecord primary key with a persisted cursor;
-- it deliberately does not create a large payload_encoding index during upgrade or maintenance.
