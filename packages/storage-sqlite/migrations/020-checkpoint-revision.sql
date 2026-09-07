ALTER TABLE source_checkpoints
ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

-- 部分存储内部失效逻辑会直接更新 value_json。若调用方没有显式推进 revision，
-- 数据库负责补一次 revision，保证 CAS 能观察到并发 dirty 写入。
CREATE TRIGGER IF NOT EXISTS trg_source_checkpoint_revision_guard
AFTER UPDATE OF value_json ON source_checkpoints
WHEN NEW.revision = OLD.revision
BEGIN
  UPDATE source_checkpoints
  SET revision = OLD.revision + 1
  WHERE scope = NEW.scope
    AND checkpoint_key = NEW.checkpoint_key
    AND revision = OLD.revision;
END;
