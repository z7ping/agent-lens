/**
 * abeat-db.js - 统计摘要存储层
 *
 * 只存聚合结果，不存原始数据。
 * 原始数据由适配器直接查各自的数据源 DB。
 */

const fs = require('fs');
const path = require('path');
const { openDb } = require('./db');

// 兼容两种布局：
//   开发/源码: <project>/server/abeat-db.js → DB 在 <project>/a-beat.db
//   已安装:     ~/.agent-trace/abeat-db.js  → DB 在 ~/.agent-trace/a-beat.db
const DB_PATH = path.basename(__dirname) === 'server'
    ? path.join(__dirname, '..', 'a-beat.db')
    : path.join(__dirname, 'a-beat.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let _db = null;

// ─── 数据库初始化 ──────────────────────────────────────

function getDb() {
  if (_db) return _db;
  const lazyDb = openDb(DB_PATH);
  // better-sqlite3 同步可用；sql.js 需要 await ready()，此处同步初始化
  try { lazyDb.ready(); } catch (_) {}
  if (!lazyDb._db) {
    console.error('[abeat-db] 无可用 SQLite 后端。a-beat.db 功能不可用。');
    console.error('  修复：npm install better-sqlite3');
    return null;
  }
  _db = lazyDb._db; // 底层原生 db 实例
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  // 迁移：旧版 timeline 表 CHECK(source) 只允许 hermes/claude-code，
  // 导致 pi/opencode/cursor/codex 等写入被静默丢弃。
  try {
    const oldSql = _db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='timeline'").pluck().get();
    // 只在约束为旧版（仅 hermes/claude-code）时重建
    const oldOnly = "CHECK(source IN ('hermes', 'claude-code'))";
    if (oldSql && oldSql.includes(oldOnly)) {
      console.log('[migrate] 重建 timeline 表（更新 source CHECK 约束）');
      _db.pragma('foreign_keys = OFF');
      _db.exec('DROP TABLE IF EXISTS timeline');
      _db.exec(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
      _db.pragma('foreign_keys = ON');
    }
  } catch (_) {}

  const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  _db.exec(schema);

  // 迁移：timeline 增加 tool_use_id 列 + 部分唯一索引（用于 JSONL 导入幂等去重）
  try {
    const cols = _db.prepare("PRAGMA table_info(timeline)").all().map(c => c.name);
    if (!cols.includes('tool_use_id')) {
      _db.exec('ALTER TABLE timeline ADD COLUMN tool_use_id TEXT');
    }
    _db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_tool_use_id ON timeline(tool_use_id) WHERE tool_use_id IS NOT NULL');
  } catch (_) {}

  return _db;
}

function closeDb() {
  if (_db) { _db.close(); _db = null; }
}

// ─── 写入方法 ──────────────────────────────────────────

/** 写入/更新 session 摘要 */
function upsertSession(session) {
  const db = getDb();
  db.prepare(`
    INSERT INTO sessions (session_id, project_key, source, start_time, end_time, tool_count, error_count, total_duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      end_time = excluded.end_time,
      tool_count = excluded.tool_count,
      error_count = excluded.error_count,
      total_duration_ms = excluded.total_duration_ms
  `).run(
    session.session_id,
    session.project_key || '',
    session.source || '',
    session.start_time || '',
    session.end_time || '',
    session.tool_count || 0,
    session.error_count || 0,
    session.total_duration_ms || 0
  );
}

/** 累加按天统计 */
function updateDailyStats(date, source, toolName, callCount, errorCount, avgDurationMs) {
  const db = getDb();
  db.prepare(`
    INSERT INTO daily_stats (date, source, tool_name, call_count, error_count, avg_duration_ms)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, source, tool_name) DO UPDATE SET
      call_count = call_count + excluded.call_count,
      error_count = error_count + excluded.error_count,
      avg_duration_ms = (avg_duration_ms + excluded.avg_duration_ms) / 2
  `).run(date, source, toolName, callCount || 0, errorCount || 0, avgDurationMs || 0);
}

/** 保存最近错误（超过 50 条删除最旧） */
function saveError(ts, sessionId, source, toolName, errorMessage) {
  const db = getDb();
  db.prepare(`
    INSERT INTO recent_errors (ts, session_id, source, tool_name, error_message)
    VALUES (?, ?, ?, ?, ?)
  `).run(ts, sessionId, source, toolName, errorMessage);

  // 保留最近 50 条
  db.prepare(`
    DELETE FROM recent_errors WHERE id NOT IN (
      SELECT id FROM recent_errors ORDER BY ts DESC LIMIT 50
    )
  `).run();
}

// ─── Timeline ─────────────────────────────────────────

/** 写入一条 timeline 记录 */
function insertTimeline(record) {
  const db = getDb();

  // 错误分类：优先用传入的，否则自动分类
  let eType = record.error_type || null;
  let eDetail = record.error_detail ? (typeof record.error_detail === 'string' ? record.error_detail : JSON.stringify(record.error_detail)) : null;
  if (!eType && record.error_message) {
    const BaseAdapter = require('./adapters/base');
    const classified = BaseAdapter.prototype.classifyError(record.error_message);
    eType = classified.error_type;
    eDetail = classified.error_detail ? JSON.stringify(classified.error_detail) : null;
  }

  db.prepare(`
    INSERT OR IGNORE INTO timeline (source, session_id, timestamp, seq, role, tool_name, content, tool_input, success, exit_code, duration_ms, output_snippet, error_message, error_type, error_detail, project_key, parent_seq, tool_use_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.source || '',
    record.session_id || '',
    record.timestamp || '',
    record.seq ?? null,
    record.role || 'tool',
    record.tool_name || null,
    record.content ? String(record.content).substring(0, 2000) : null,
    record.tool_input ? (typeof record.tool_input === 'string' ? record.tool_input.substring(0, 2000) : JSON.stringify(record.tool_input).substring(0, 2000)) : null,
    record.success != null ? (record.success ? 1 : 0) : null,
    record.exit_code ?? null,
    record.duration_ms ?? null,
    record.output_snippet ? String(record.output_snippet).substring(0, 500) : null,
    record.error_message ? String(record.error_message).substring(0, 500) : null,
    eType,
    eDetail,
    record.project_key || null,
    record.parent_seq ?? null,
    record.tool_use_id || null
  );
}

/** 查询 timeline 记录 */
function queryTimeline(options = {}) {
  const db = getDb();
  const { session_id, source, project_key, limit = 1000 } = options;
  let where = 'WHERE 1=1';
  const params = [];
  if (session_id) { where += ' AND session_id = ?'; params.push(session_id); }
  if (source) { where += ' AND source = ?'; params.push(source); }
  if (project_key) { where += ' AND project_key = ?'; params.push(project_key); }

  return db.prepare(`
    SELECT * FROM timeline ${where} ORDER BY timestamp ASC LIMIT ?
  `).all(...params, limit);
}

// ─── 查询方法 ──────────────────────────────────────────

/** 查询统计信息（仪表盘用） */
function queryStats(options = {}) {
  const db = getDb();
  const { source, since } = options;
  let where = 'WHERE 1=1';
  const params = [];
  if (source) { where += ' AND source = ?'; params.push(source); }
  if (since) { where += ' AND date >= ?'; params.push(since); }

  const byTool = db.prepare(`
    SELECT tool_name, SUM(call_count) as count, SUM(error_count) as errors, AVG(avg_duration_ms) as avg_duration_ms
    FROM daily_stats ${where}
    GROUP BY tool_name ORDER BY count DESC
  `).all(...params);

  const bySource = db.prepare(`
    SELECT source, SUM(call_count) as count, SUM(error_count) as errors
    FROM daily_stats ${where}
    GROUP BY source ORDER BY count DESC
  `).all(...params);

  const byDay = db.prepare(`
    SELECT date, SUM(call_count) as count, SUM(error_count) as errors
    FROM daily_stats ${where}
    GROUP BY date ORDER BY date ASC
  `).all(...params);

  const totals = db.prepare(`
    SELECT
      SUM(call_count) as total_calls,
      SUM(error_count) as total_errors,
      COUNT(DISTINCT (SELECT session_id FROM sessions)) as session_count
    FROM daily_stats ${where}
  `).get(...params);

  return { totals, byTool, bySource, byDay };
}

/** 查询 session 列表 */
function querySessions(options = {}) {
  const db = getDb();
  const { source, projectKey, limit = 50 } = options;
  let where = 'WHERE 1=1';
  const params = [];
  if (source) { where += ' AND source = ?'; params.push(source); }
  if (projectKey) { where += ' AND project_key = ?'; params.push(projectKey); }

  return db.prepare(`
    SELECT * FROM sessions ${where}
    ORDER BY start_time DESC LIMIT ?
  `).all(...params, limit);
}

/** 获取 session 已有的 total_duration_ms */
function getSessionDuration(sessionId) {
  const db = getDb();
  const row = db.prepare('SELECT total_duration_ms FROM sessions WHERE session_id = ?').get(sessionId);
  return row ? (row.total_duration_ms || 0) : 0;
}

/** 查询最近错误 */
function queryRecentErrors(limit = 50) {
  const db = getDb();
  return db.prepare('SELECT * FROM recent_errors ORDER BY ts DESC LIMIT ?').all(limit);
}

/** 查询按天趋势（图表用） */
function queryDailyTrend(options = {}) {
  const db = getDb();
  const { source, days = 30 } = options;
  let where = `WHERE date >= date('now', '-${days} days')`;
  const params = [];
  if (source) { where += ' AND source = ?'; params.push(source); }

  return db.prepare(`
    SELECT date, source, SUM(call_count) as count, SUM(error_count) as errors
    FROM daily_stats ${where}
    GROUP BY date, source
    ORDER BY date ASC
  `).all(...params);
}

module.exports = {
  getDb,
  closeDb,
  upsertSession,
  getSessionDuration,
  updateDailyStats,
  saveError,
  insertTimeline,
  queryTimeline,
  queryStats,
  querySessions,
  queryRecentErrors,
  queryDailyTrend,
  DB_PATH,
};
