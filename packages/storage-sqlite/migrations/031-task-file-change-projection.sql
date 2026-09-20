CREATE TABLE IF NOT EXISTS task_file_change_capture (
  runtime_session_id TEXT PRIMARY KEY,
  logical_session_id TEXT,
  workspace_path TEXT NOT NULL,
  git_root_path TEXT,
  baseline_tree_sha TEXT,
  baseline_captured_at TEXT NOT NULL,
  final_tree_sha TEXT,
  finalized_at TEXT,
  changes_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_file_change_capture_session
ON task_file_change_capture(logical_session_id, finalized_at DESC, runtime_session_id);

CREATE TABLE IF NOT EXISTS task_file_change_projection (
  logical_session_id TEXT NOT NULL,
  path TEXT NOT NULL,
  change_type TEXT NOT NULL
    CHECK(change_type IN ('added','modified','deleted','renamed','unknown')),
  old_path TEXT,
  additions INTEGER,
  deletions INTEGER,
  first_changed_at TEXT NOT NULL,
  last_changed_at TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  confidence TEXT NOT NULL
    CHECK(confidence IN ('exact','high','medium','low')),
  PRIMARY KEY(logical_session_id, path)
);

CREATE INDEX IF NOT EXISTS idx_task_file_change_projection_session
ON task_file_change_projection(logical_session_id, last_changed_at DESC, path ASC);
