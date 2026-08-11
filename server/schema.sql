-- agent-lens.db Schema
-- Version: 4

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Session 摘要。session_key 为来源命名空间内的稳定主键。
CREATE TABLE IF NOT EXISTS sessions (
  session_key TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  session_id TEXT NOT NULL,
  project_key TEXT,
  start_time TEXT,
  end_time TEXT,
  tool_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  total_duration_ms INTEGER DEFAULT 0,
  UNIQUE (source, session_id)
);

-- 按天+工具聚合统计
CREATE TABLE IF NOT EXISTS daily_stats (
  date TEXT,
  source TEXT,
  tool_name TEXT,
  call_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  avg_duration_ms REAL DEFAULT 0,
  PRIMARY KEY (date, source, tool_name)
);

-- 最近错误（滚动保留 50 条）
CREATE TABLE IF NOT EXISTS recent_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT,
  session_id TEXT,
  source TEXT,
  tool_name TEXT,
  error_message TEXT
);

-- 统一可观测事件。保留旧字段用于 API 和历史任务兼容。
CREATE TABLE IF NOT EXISTS timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_event_id TEXT,
  session_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent_id TEXT,
  turn_id TEXT,
  parent_event_id TEXT,
  timestamp TEXT NOT NULL,
  source_sequence INTEGER,
  seq INTEGER,
  event_type TEXT NOT NULL,
  role TEXT NOT NULL,
  call_id TEXT,
  tool_use_id TEXT,
  tool_name TEXT,
  content TEXT,
  tool_input TEXT,
  success INTEGER,
  exit_code INTEGER,
  duration_ms REAL,
  output_snippet TEXT,
  error_message TEXT,
  error_type TEXT,
  error_detail TEXT,
  project_key TEXT,
  parent_seq INTEGER,
  capture_method TEXT NOT NULL DEFAULT 'legacy_import',
  visibility TEXT NOT NULL DEFAULT 'captured',
  confidence TEXT NOT NULL DEFAULT 'unknown',
  missing_reason TEXT,
  redaction_applied INTEGER,
  capture_policy TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_event_id ON timeline(event_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_source_event
  ON timeline(source, session_key, source_event_id, event_type)
  WHERE source_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_timeline_session ON timeline(session_key, timestamp, id);
CREATE INDEX IF NOT EXISTS idx_timeline_native_session ON timeline(source, session_id, timestamp, id);
CREATE INDEX IF NOT EXISTS idx_timeline_source ON timeline(source, timestamp);
CREATE INDEX IF NOT EXISTS idx_timeline_call ON timeline(source, session_key, call_id, event_type);
CREATE INDEX IF NOT EXISTS idx_timeline_parent_event ON timeline(parent_event_id);
CREATE INDEX IF NOT EXISTS idx_timeline_tool ON timeline(source, tool_name, timestamp);
CREATE INDEX IF NOT EXISTS idx_timeline_role ON timeline(role, timestamp);
CREATE INDEX IF NOT EXISTS idx_timeline_error ON timeline(role, success, error_type);

CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_key);
CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(date);
CREATE INDEX IF NOT EXISTS idx_recent_errors_ts ON recent_errors(ts DESC);

-- 概览：AI 工具稳定资产快照
CREATE TABLE IF NOT EXISTS overview_tools (
  tool TEXT PRIMARY KEY,
  display_name TEXT,
  description TEXT,
  version TEXT,
  status TEXT,
  config_dir TEXT,
  theme_json TEXT,
  last_scanned_at TEXT
);

CREATE TABLE IF NOT EXISTS overview_assets (
  tool TEXT NOT NULL,
  name TEXT NOT NULL,
  capability TEXT NOT NULL,
  type TEXT,
  status TEXT,
  path TEXT,
  description TEXT,
  last_scanned_at TEXT,
  PRIMARY KEY (tool, capability, type, path),
  FOREIGN KEY (tool) REFERENCES overview_tools(tool) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS overview_scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT,
  finished_at TEXT,
  status TEXT,
  tool_count INTEGER DEFAULT 0,
  asset_count INTEGER DEFAULT 0,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_overview_assets_tool ON overview_assets(tool, type);
CREATE INDEX IF NOT EXISTS idx_overview_scan_runs_started ON overview_scan_runs(started_at DESC);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '4')
ON CONFLICT(key) DO NOTHING;
