ALTER TABLE source_records ADD COLUMN payload_encoding TEXT NOT NULL DEFAULT 'json';
ALTER TABLE source_records ADD COLUMN payload_blob BLOB;

-- Legacy rows stay as payload_encoding=json until cooperative maintenance processes them.
-- New repository writes use plain-json or gzip-json immediately.
-- 待压缩行索引可能在大库升级时构建很久，因此不在启动迁移阶段创建；
-- 由 SqliteStorageMaintenance.ensureDeferredIndexes() 在前台可用后的维护阶段创建。
