-- agent-lens.db Schema
-- Version: 2.0
-- 仅存统计摘要，不存原始数据

-- session 摘要
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  project_key TEXT,
  source TEXT,              -- hermes/opencode/claude-code
  start_time TEXT,
  end_time TEXT,
  tool_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  total_duration_ms INTEGER DEFAULT 0
);

-- 按天+工具聚合统计
CREATE TABLE IF NOT EXISTS daily_stats (
  date TEXT,                -- YYYY-MM-DD
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

-- 索引
CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_key);
CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(date);
CREATE INDEX IF NOT EXISTS idx_recent_errors_ts ON recent_errors(ts DESC);

-- 时间线（原始调用记录）
-- role 值: user, assistant, system, tool_use, tool_result, tool_error,
--          session_start, session_end, compact, notification
-- source 值: hermes, claude-code
CREATE TABLE IF NOT EXISTS timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK(source IN ('hermes', 'claude-code', 'codex', 'opencode', 'cursor', 'pi', 'openclaw')),
  session_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  seq INTEGER,
  role TEXT NOT NULL CHECK(role IN (
    'user', 'assistant', 'system',
    'tool_use', 'tool_result', 'tool_error',
    'session_start', 'session_end', 'compact', 'notification'
  )),
  tool_name TEXT,
  content TEXT,
  tool_input TEXT,
  success INTEGER,
  exit_code INTEGER,
  duration_ms REAL,
  output_snippet TEXT,
  error_message TEXT,
  error_type TEXT,        -- windows_command | path_not_found | permission | timeout | syntax | unknown
  error_detail TEXT,      -- JSON: {stderr, full_error, hint}
  project_key TEXT,
  parent_seq INTEGER
);

CREATE INDEX IF NOT EXISTS idx_timeline_session ON timeline(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_timeline_source ON timeline(source, timestamp);
CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_dedup ON timeline(session_id, timestamp, role);

-- 分析查询索引
CREATE INDEX IF NOT EXISTS idx_timeline_tool ON timeline(source, tool_name, timestamp);
CREATE INDEX IF NOT EXISTS idx_timeline_role ON timeline(role, timestamp);
CREATE INDEX IF NOT EXISTS idx_timeline_error ON timeline(role, success, error_type);

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
