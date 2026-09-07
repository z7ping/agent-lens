CREATE TABLE IF NOT EXISTS maintenance_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  scope TEXT NOT NULL,
  priority INTEGER NOT NULL,
  state TEXT NOT NULL,
  progress_json TEXT,
  error_summary TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE(type, scope)
);

CREATE INDEX IF NOT EXISTS idx_maintenance_jobs_state_priority
ON maintenance_jobs(state, priority ASC, updated_at ASC, id ASC);
