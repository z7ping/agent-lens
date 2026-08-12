/**
 * agent-lens-db.js - 统一事件与统计存储层
 *
 * Timeline 保存经过采集策略处理的对话、工具事件及证据元数据；
 * Session 与 daily_stats 保存面向仪表盘的派生摘要。
 */

const path = require('path');
const { openDb } = require('./db');
const { ensureRuntimeDirs, getRuntimePaths } = require('./runtime-paths');
const { initializeDatabase } = require('./migrations');
const { makeSessionKey, makeEventId, normalizeEventRecord, stableHash } = require('./event-model');
const { sanitizeEventRecord } = require('./privacy');

const RUNTIME_PATHS = getRuntimePaths({ baseDir: __dirname });
ensureRuntimeDirs(RUNTIME_PATHS);
const DB_PATH = RUNTIME_PATHS.dbFile;
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let _db = null;

// ─── 数据库初始化 ──────────────────────────────────────

function getDb() {
  if (_db) return _db;
  const lazyDb = openDb(DB_PATH);
  // better-sqlite3 同步可用；sql.js 需要 await ready()，此处同步初始化
  try { lazyDb.ready(); } catch (_) {}
  if (!lazyDb._db) {
    console.error('[agent-lens-db] 无可用 SQLite 后端。agent-lens.db 功能不可用。');
    console.error('  修复：npm install better-sqlite3');
    return null;
  }
  _db = lazyDb._db; // 底层原生 db 实例
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  const migration = initializeDatabase(_db, { dbPath: DB_PATH, schemaPath: SCHEMA_PATH });
  if (migration.migrated) {
    console.log(`[migrate] 数据库 Schema ${migration.fromVersion} -> ${migration.toVersion}`);
    if (migration.backupPath) console.log(`[migrate] 旧数据库备份：${migration.backupPath}`);
  }

  return _db;
}

function closeDb() {
  if (_db) { _db.close(); _db = null; }
}

// ─── 写入方法 ──────────────────────────────────────────

/** 写入/更新 session 摘要 */
function upsertSession(session, dbOverride = null) {
  const db = dbOverride || getDb();
  const source = String(session.source || 'unknown');
  const sessionId = String(session.session_id || '');
  if (!sessionId) return;
  const sessionKey = session.session_key || makeSessionKey(source, sessionId);
  db.prepare(`
    INSERT INTO sessions (session_key, source, session_id, project_key, start_time, end_time, tool_count, error_count, total_duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_key) DO UPDATE SET
      project_key = COALESCE(NULLIF(excluded.project_key, ''), project_key),
      start_time = CASE
        WHEN start_time IS NULL OR start_time = '' THEN excluded.start_time
        WHEN excluded.start_time IS NULL OR excluded.start_time = '' THEN start_time
        ELSE MIN(start_time, excluded.start_time)
      END,
      end_time = CASE
        WHEN end_time IS NULL OR end_time = '' THEN excluded.end_time
        WHEN excluded.end_time IS NULL OR excluded.end_time = '' THEN end_time
        ELSE MAX(end_time, excluded.end_time)
      END,
      tool_count = excluded.tool_count,
      error_count = excluded.error_count,
      total_duration_ms = excluded.total_duration_ms
  `).run(
    sessionKey,
    source,
    sessionId,
    session.project_key || '',
    session.start_time || '',
    session.end_time || '',
    session.tool_count || 0,
    session.error_count || 0,
    session.total_duration_ms || 0
  );
}

/** 累加按天统计 */
function updateDailyStats(date, source, toolName, callCount, errorCount, avgDurationMs, dbOverride = null) {
  const db = dbOverride || getDb();
  db.prepare(`
    INSERT INTO daily_stats (date, source, tool_name, call_count, error_count, avg_duration_ms)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, source, tool_name) DO UPDATE SET
      avg_duration_ms = CASE
        WHEN call_count + excluded.call_count > 0
          THEN ((avg_duration_ms * call_count) + (excluded.avg_duration_ms * excluded.call_count))
            / (call_count + excluded.call_count)
        ELSE 0
      END,
      call_count = call_count + excluded.call_count,
      error_count = error_count + excluded.error_count
  `).run(date, source, toolName, callCount || 0, errorCount || 0, avgDurationMs || 0);
}

/** 保存最近错误（超过 50 条删除最旧） */
function saveError(ts, sessionId, source, toolName, errorMessage, dbOverride = null) {
  const db = dbOverride || getDb();
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
function insertTimeline(record, dbOverride = null) {
  const db = dbOverride || getDb();

  let normalized = normalizeEventRecord(record);

  // 错误分类：优先用传入的，否则自动分类
  let eType = normalized.error_type || null;
  let eDetail = normalized.error_detail ? (typeof normalized.error_detail === 'string' ? normalized.error_detail : JSON.stringify(normalized.error_detail)) : null;
  if (!eType && normalized.error_message) {
    const BaseAdapter = require('./adapters/base');
    const classified = BaseAdapter.prototype.classifyError(normalized.error_message);
    eType = classified.error_type;
    eDetail = classified.error_detail ? JSON.stringify(classified.error_detail) : null;
  }
  normalized = sanitizeEventRecord({ ...normalized, error_type: eType, error_detail: eDetail });

  const content = normalized.content != null ? String(normalized.content) : null;
  const toolInput = normalized.tool_input != null
    ? (typeof normalized.tool_input === 'string' ? normalized.tool_input : JSON.stringify(normalized.tool_input))
    : null;
  const outputSnippet = normalized.output_snippet != null ? String(normalized.output_snippet) : null;
  const errorMessage = normalized.error_message != null ? String(normalized.error_message) : null;
  const errorDetail = normalized.error_detail != null
    ? (typeof normalized.error_detail === 'string' ? normalized.error_detail : JSON.stringify(normalized.error_detail))
    : null;
  const attributesJson = normalized.attributes_json != null
    ? (typeof normalized.attributes_json === 'string' ? normalized.attributes_json : JSON.stringify(normalized.attributes_json))
    : null;

  const insertInfo = db.prepare(`
    INSERT OR IGNORE INTO timeline (
      event_id, source, source_event_id, session_key, session_id, agent_id, turn_id,
      parent_event_id, timestamp, source_sequence, seq, event_type, role, call_id,
      tool_use_id, tool_name, content, tool_input, success, exit_code, duration_ms,
      output_snippet, error_message, error_type, error_detail, project_key, parent_seq,
      capture_method, visibility, confidence, missing_reason, redaction_applied, capture_policy,
      attributes_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    normalized.event_id,
    normalized.source,
    normalized.source_event_id || null,
    normalized.session_key,
    normalized.session_id,
    normalized.agent_id || null,
    normalized.turn_id || null,
    normalized.parent_event_id || null,
    normalized.timestamp || '',
    normalized.source_sequence ?? null,
    normalized.seq ?? null,
    normalized.event_type,
    normalized.role,
    normalized.call_id || null,
    normalized.tool_use_id || null,
    normalized.tool_name || null,
    content,
    toolInput,
    normalized.success != null ? (normalized.success ? 1 : 0) : null,
    normalized.exit_code ?? null,
    normalized.duration_ms ?? null,
    outputSnippet,
    errorMessage,
    normalized.error_type || null,
    errorDetail,
    normalized.project_key || null,
    normalized.parent_seq ?? null,
    normalized.capture_method,
    normalized.visibility,
    normalized.confidence,
    normalized.missing_reason || null,
    normalized.redaction_applied ?? null,
    normalized.capture_policy || null,
    attributesJson,
  );

  if (insertInfo.changes === 0) {
    db.prepare(`
      UPDATE timeline SET
        source_event_id = COALESCE(?, source_event_id),
        agent_id = COALESCE(?, agent_id),
        turn_id = COALESCE(?, turn_id),
        parent_event_id = COALESCE(?, parent_event_id),
        source_sequence = COALESCE(?, source_sequence),
        seq = COALESCE(?, seq),
        call_id = COALESCE(?, call_id),
        tool_use_id = COALESCE(?, tool_use_id),
        tool_name = COALESCE(?, tool_name),
        content = COALESCE(?, content),
        tool_input = COALESCE(?, tool_input),
        success = COALESCE(?, success),
        exit_code = COALESCE(?, exit_code),
        duration_ms = COALESCE(?, duration_ms),
        output_snippet = COALESCE(?, output_snippet),
        error_message = COALESCE(?, error_message),
        error_type = COALESCE(?, error_type),
        error_detail = COALESCE(?, error_detail),
        project_key = COALESCE(?, project_key),
        parent_seq = COALESCE(?, parent_seq),
        capture_method = COALESCE(?, capture_method),
        visibility = COALESCE(?, visibility),
        confidence = COALESCE(?, confidence),
        missing_reason = COALESCE(?, missing_reason),
        redaction_applied = COALESCE(?, redaction_applied),
        capture_policy = COALESCE(?, capture_policy),
        attributes_json = COALESCE(?, attributes_json)
      WHERE event_id = ?
    `).run(
      normalized.source_event_id || null, normalized.agent_id || null, normalized.turn_id || null,
      normalized.parent_event_id || null, normalized.source_sequence ?? null, normalized.seq ?? null,
      normalized.call_id || null, normalized.tool_use_id || null, normalized.tool_name || null,
      content, toolInput, normalized.success != null ? (normalized.success ? 1 : 0) : null,
      normalized.exit_code ?? null, normalized.duration_ms ?? null, outputSnippet, errorMessage,
      normalized.error_type || null, errorDetail, normalized.project_key || null,
      normalized.parent_seq ?? null, normalized.capture_method, normalized.visibility,
      normalized.confidence, normalized.missing_reason || null, normalized.redaction_applied ?? null,
      normalized.capture_policy || null, attributesJson, normalized.event_id,
    );
  }

  return insertInfo;
}

/** 将来源中的合并工具记录规范化为独立 Tool Use 与 Tool Result 事件。 */
function insertToolEventPair(record, dbOverride = null) {
  const source = String(record.source || 'unknown');
  const sessionId = String(record.session_id || '');
  const resultType = record.role === 'tool_error' || record.success === false || record.success === 0
    ? 'tool_error'
    : 'tool_result';
  const fallbackIdentity = JSON.stringify({
    source, sessionId, source_sequence: record.source_sequence ?? record.seq ?? null,
    timestamp: record.timestamp || record.ts || '', tool_name: record.tool_name || '',
    tool_input: record.tool_input || null,
  });
  const callId = record.call_id || record.tool_use_id || record.source_event_id || `synthetic-${stableHash(fallbackIdentity).slice(0, 24)}`;
  const useEventId = record.tool_use_event_id || makeEventId({
    source, session_id: sessionId, event_type: 'tool_use', call_id: callId,
  });
  const syntheticReason = record.missing_reason || '来源未提供独立 Tool Use 时间，调用事件由同一原生记录拆分';
  const useInfo = insertTimeline({
    ...record,
    event_id: useEventId,
    event_type: 'tool_use',
    role: 'tool_use',
    timestamp: record.tool_started_at || record.timestamp || record.ts || '',
    call_id: callId,
    tool_use_id: callId,
    success: null,
    exit_code: null,
    duration_ms: null,
    output_snippet: null,
    error_message: null,
    error_type: null,
    error_detail: null,
    parent_event_id: record.parent_event_id || null,
    confidence: record.tool_started_at ? (record.confidence || 'confirmed') : 'partial',
    missing_reason: record.tool_started_at ? (record.missing_reason || null) : syntheticReason,
  }, dbOverride);
  const resultInfo = insertTimeline({
    ...record,
    event_id: record.event_id || undefined,
    event_type: resultType,
    role: resultType,
    timestamp: record.result_timestamp || record.timestamp || record.ts || '',
    call_id: callId,
    tool_use_id: callId,
    parent_event_id: useEventId,
    confidence: record.confidence || 'confirmed',
  }, dbOverride);
  return { useInfo, resultInfo, callId, useEventId };
}

/** 查询 timeline 记录 */
function queryTimeline(options = {}, dbOverride = null) {
  const db = dbOverride || getDb();
  const { session_id, session_key, source, project_key, limit = 1000 } = options;
  let where = 'WHERE 1=1';
  const params = [];
  if (session_id) { where += ' AND session_id = ?'; params.push(session_id); }
  if (session_key) { where += ' AND session_key = ?'; params.push(session_key); }
  if (source) { where += ' AND source = ?'; params.push(source); }
  if (project_key) { where += ' AND project_key = ?'; params.push(project_key); }

  return db.prepare(`
    SELECT * FROM timeline ${where} ORDER BY timestamp ASC, COALESCE(source_sequence, seq, id) ASC, id ASC LIMIT ?
  `).all(...params, limit);
}

/** 依据 Timeline 结果事件重算单个 Session 摘要。 */
function recomputeSession(source, sessionId, fallbackProjectKey = '', dbOverride = null) {
  const db = dbOverride || getDb();
  const summary = db.prepare(`
    SELECT
      MIN(timestamp) AS start_time,
      MAX(timestamp) AS end_time,
      SUM(CASE WHEN role IN ('tool_result', 'tool_error') THEN 1 ELSE 0 END) AS tool_count,
      SUM(CASE WHEN role IN ('tool_result', 'tool_error') AND success = 0 THEN 1 ELSE 0 END) AS error_count,
      SUM(CASE WHEN role IN ('tool_result', 'tool_error') THEN COALESCE(duration_ms, 0) ELSE 0 END) AS total_duration_ms
    FROM timeline
    WHERE source = ? AND session_id = ?
  `).get(source, sessionId);
  const project = db.prepare(`
    SELECT project_key FROM timeline
    WHERE source = ? AND session_id = ? AND project_key IS NOT NULL AND project_key != ''
    ORDER BY timestamp DESC, id DESC LIMIT 1
  `).get(source, sessionId);
  if (!summary?.start_time) return null;
  const session = {
    session_key: makeSessionKey(source, sessionId),
    source,
    session_id: sessionId,
    project_key: project?.project_key || fallbackProjectKey || '',
    start_time: summary.start_time || '',
    end_time: summary.end_time || '',
    tool_count: summary.tool_count || 0,
    error_count: summary.error_count || 0,
    total_duration_ms: summary.total_duration_ms || 0,
  };
  upsertSession(session, db);
  return session;
}

// ─── 查询方法 ──────────────────────────────────────────

/** 查询统计信息（仪表盘用） */
function queryStats(options = {}, dbOverride = null) {
  const db = dbOverride || getDb();
  const { source, since } = options;
  let where = 'WHERE 1=1';
  const params = [];
  if (source) { where += ' AND source = ?'; params.push(source); }
  if (since) { where += ' AND date >= ?'; params.push(since); }

  const byTool = db.prepare(`
    SELECT tool_name,
      SUM(call_count) as count,
      SUM(error_count) as errors,
      CASE WHEN SUM(call_count) > 0
        THEN SUM(avg_duration_ms * call_count) / SUM(call_count)
        ELSE 0
      END as avg_duration_ms
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
      SUM(error_count) as total_errors
    FROM daily_stats ${where}
  `).get(...params);

  let sessionWhere = 'WHERE 1=1';
  const sessionParams = [];
  if (source) { sessionWhere += ' AND source = ?'; sessionParams.push(source); }
  if (since) { sessionWhere += " AND substr(start_time, 1, 10) >= ?"; sessionParams.push(since); }
  totals.session_count = db.prepare(`SELECT COUNT(*) AS count FROM sessions ${sessionWhere}`).get(...sessionParams).count;
  totals.total_calls = totals.total_calls || 0;
  totals.total_errors = totals.total_errors || 0;

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
function getSessionDuration(source, sessionId) {
  const db = getDb();
  if (sessionId === undefined) {
    sessionId = source;
    source = null;
  }
  const row = source
    ? db.prepare('SELECT total_duration_ms FROM sessions WHERE source = ? AND session_id = ?').get(source, sessionId)
    : db.prepare('SELECT total_duration_ms FROM sessions WHERE session_id = ? ORDER BY source LIMIT 1').get(sessionId);
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
  insertToolEventPair,
  queryTimeline,
  recomputeSession,
  queryStats,
  querySessions,
  queryRecentErrors,
  queryDailyTrend,
  DB_PATH,
};
