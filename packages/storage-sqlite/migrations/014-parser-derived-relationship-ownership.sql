PRAGMA foreign_keys = ON;

ALTER TABLE session_relationship_candidates
  ADD COLUMN source_record_id TEXT REFERENCES source_records(id);

CREATE INDEX IF NOT EXISTS idx_relationship_candidates_source_record
  ON session_relationship_candidates(source_record_id);

-- Parser 13/14 曾把 Codex session_id 误解释为线程根关系。
-- 当前 Codex 契约明确 session_id 是整个 thread tree 共享的 session 标识，
-- 因此这些历史 task-root 派生必须在升级时一次性撤销。
DELETE FROM session_relationships
WHERE type = 'task-root'
  AND EXISTS (
    SELECT 1
    FROM session_relationship_candidates c
    JOIN source_sessions from_ss
      ON from_ss.source_id = c.source_id
     AND from_ss.installation_id = c.installation_id
     AND from_ss.native_session_id = c.from_native_session_id
    JOIN source_sessions to_ss
      ON to_ss.source_id = c.source_id
     AND to_ss.installation_id = c.installation_id
     AND to_ss.native_session_id = c.to_native_session_id
    WHERE c.source_id = 'codex'
      AND c.native_relation = 'session_id'
      AND from_ss.logical_session_id = session_relationships.from_session_id
      AND to_ss.logical_session_id = session_relationships.to_session_id
  );

DELETE FROM session_relationship_candidates
WHERE source_id = 'codex'
  AND native_relation = 'session_id';
