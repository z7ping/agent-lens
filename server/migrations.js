const fs = require('fs');
const path = require('path');
const { makeEventId, makeSessionKey } = require('./event-model');

const CURRENT_SCHEMA_VERSION = 5;

const SESSION_TABLE_SQL = `
  CREATE TABLE sessions_v4 (
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
  )`;

const TIMELINE_TABLE_SQL = `
  CREATE TABLE timeline_v4 (
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
  )`;

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function getColumns(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
}

function readSchemaVersion(db) {
  if (!tableExists(db, 'schema_meta')) return null;
  const row = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get();
  const version = Number.parseInt(row?.value, 10);
  return Number.isFinite(version) ? version : null;
}

function inferSchemaVersion(db) {
  if (!tableExists(db, 'timeline')) return 0;
  const timelineColumns = getColumns(db, 'timeline');
  const sessionColumns = getColumns(db, 'sessions');
  if (timelineColumns.has('attributes_json') && timelineColumns.has('event_id') && sessionColumns.has('session_key')) return 5;
  if (timelineColumns.has('event_id') && timelineColumns.has('session_key') && sessionColumns.has('session_key')) return 4;
  return 2;
}

function createBackup(db, dbPath, fromVersion) {
  if (!dbPath || dbPath === ':memory:' || !fs.existsSync(dbPath)) return null;
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${dbPath}.v${fromVersion}.backup-${stamp}`;
  fs.copyFileSync(dbPath, backupPath, fs.constants.COPYFILE_EXCL);
  return backupPath;
}

function migrateSessions(db) {
  const oldRows = tableExists(db, 'sessions') ? db.prepare('SELECT * FROM sessions').all() : [];
  db.exec('DROP TABLE IF EXISTS sessions_v4');
  db.exec(SESSION_TABLE_SQL);
  const insert = db.prepare(`
    INSERT INTO sessions_v4 (
      session_key, source, session_id, project_key, start_time, end_time,
      tool_count, error_count, total_duration_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_key) DO UPDATE SET
      project_key = COALESCE(excluded.project_key, project_key),
      start_time = CASE WHEN start_time IS NULL OR start_time = '' OR excluded.start_time < start_time THEN excluded.start_time ELSE start_time END,
      end_time = CASE WHEN end_time IS NULL OR excluded.end_time > end_time THEN excluded.end_time ELSE end_time END,
      tool_count = MAX(tool_count, excluded.tool_count),
      error_count = MAX(error_count, excluded.error_count),
      total_duration_ms = MAX(total_duration_ms, excluded.total_duration_ms)
  `);
  for (const row of oldRows) {
    const source = String(row.source || 'unknown');
    const sessionId = String(row.session_id || '');
    if (!sessionId) continue;
    insert.run(
      row.session_key || makeSessionKey(source, sessionId), source, sessionId,
      row.project_key || '', row.start_time || '', row.end_time || '',
      row.tool_count || 0, row.error_count || 0, row.total_duration_ms || 0,
    );
  }
  if (tableExists(db, 'sessions')) db.exec('DROP TABLE sessions');
  db.exec('ALTER TABLE sessions_v4 RENAME TO sessions');
}

function migrateTimeline(db) {
  const hasOld = tableExists(db, 'timeline');
  const oldCount = hasOld ? db.prepare('SELECT COUNT(*) AS count FROM timeline').get().count : 0;
  const columns = getColumns(db, 'timeline');
  db.exec('DROP TABLE IF EXISTS timeline_v4');
  db.exec(TIMELINE_TABLE_SQL);

  if (hasOld) {
    const insert = db.prepare(`
      INSERT INTO timeline_v4 (
        id, event_id, source, source_event_id, session_key, session_id,
        agent_id, turn_id, parent_event_id, timestamp, source_sequence, seq,
        event_type, role, call_id, tool_use_id, tool_name, content, tool_input,
        success, exit_code, duration_ms, output_snippet, error_message, error_type,
        error_detail, project_key, parent_seq, capture_method, visibility, confidence,
        missing_reason, redaction_applied, capture_policy
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);
    let lastId = -1;
    while (true) {
      const rows = db.prepare('SELECT * FROM timeline WHERE id > ? ORDER BY id LIMIT 1000').all(lastId);
      if (rows.length === 0) break;
      for (const row of rows) {
        const source = String(row.source || 'unknown');
        const sessionId = String(row.session_id || '');
        const sessionKey = columns.has('session_key') && row.session_key
          ? row.session_key
          : makeSessionKey(source, sessionId);
        const role = String(row.role || 'notification');
        const eventType = columns.has('event_type') && row.event_type ? row.event_type : role;
        const legacyToolUseId = columns.has('tool_use_id') ? row.tool_use_id : null;
        const sourceEventId = (columns.has('source_event_id') ? row.source_event_id : null) || legacyToolUseId || null;
        const eventId = columns.has('event_id') && row.event_id
          ? row.event_id
          : makeEventId({ source, session_id: sessionId, session_key: sessionKey, event_type: eventType, source_event_id: sourceEventId || `legacy-row-${row.id}` });
        const isToolEvent = ['tool_use', 'tool_result', 'tool_error'].includes(eventType);
        const callId = columns.has('call_id') && row.call_id ? row.call_id : (isToolEvent ? legacyToolUseId : null);
        insert.run(
          row.id, eventId, source, sourceEventId, sessionKey, sessionId,
          columns.has('agent_id') ? row.agent_id : null,
          columns.has('turn_id') ? row.turn_id : null,
          columns.has('parent_event_id') ? row.parent_event_id : null,
          row.timestamp || '',
          columns.has('source_sequence') ? row.source_sequence : (row.seq ?? row.id),
          row.seq ?? null, eventType, role, callId, legacyToolUseId || callId,
          row.tool_name || null, row.content ?? null, row.tool_input ?? null,
          row.success ?? null, row.exit_code ?? null, row.duration_ms ?? null,
          row.output_snippet ?? null, row.error_message ?? null, row.error_type ?? null,
          row.error_detail ?? null, row.project_key ?? null, row.parent_seq ?? null,
          columns.has('capture_method') ? (row.capture_method || 'legacy_import') : 'legacy_import',
          columns.has('visibility') ? (row.visibility || 'captured') : 'captured',
          columns.has('confidence') ? (row.confidence || 'unknown') : 'unknown',
          columns.has('missing_reason') ? row.missing_reason : 'v0.4 之前的记录缺少统一证据元数据',
          columns.has('redaction_applied') ? row.redaction_applied : null,
          columns.has('capture_policy') ? row.capture_policy : 'legacy_unknown',
        );
        lastId = row.id;
      }
    }
  }

  const newCount = db.prepare('SELECT COUNT(*) AS count FROM timeline_v4').get().count;
  if (newCount !== oldCount) throw new Error(`Timeline 迁移校验失败：${oldCount} -> ${newCount}`);
  if (hasOld) db.exec('DROP TABLE timeline');
  db.exec('ALTER TABLE timeline_v4 RENAME TO timeline');
}

function createIndexes(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_timeline_dedup;
    DROP INDEX IF EXISTS idx_timeline_tool_use_id;
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
  `);
}

function migrateToV4(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    migrateSessions(db);
    migrateTimeline(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', '4')
      ON CONFLICT(key) DO UPDATE SET value=excluded.value;
    `);
    createIndexes(db);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

function migrateToV5(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns = getColumns(db, 'timeline');
    if (!columns.has('attributes_json')) {
      db.exec('ALTER TABLE timeline ADD COLUMN attributes_json TEXT');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', '5')
      ON CONFLICT(key) DO UPDATE SET value=excluded.value;
    `);
    createIndexes(db);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

function initializeDatabase(db, options = {}) {
  const schemaPath = options.schemaPath || path.join(__dirname, 'schema.sql');
  const inferredVersion = readSchemaVersion(db) ?? inferSchemaVersion(db);

  if (inferredVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(`数据库 Schema 版本 ${inferredVersion} 高于当前程序支持的 ${CURRENT_SCHEMA_VERSION}，已拒绝写入`);
  }

  if (inferredVersion === 0) {
    db.exec(fs.readFileSync(schemaPath, 'utf-8'));
    return { fromVersion: 0, toVersion: CURRENT_SCHEMA_VERSION, backupPath: null, migrated: false };
  }

  let backupPath = null;
  if (inferredVersion < CURRENT_SCHEMA_VERSION) {
    backupPath = createBackup(db, options.dbPath, inferredVersion);
    let workingVersion = inferredVersion;
    if (workingVersion < 4) {
      migrateToV4(db);
      workingVersion = 4;
    }
    if (workingVersion < 5) migrateToV5(db);
  }
  db.exec(fs.readFileSync(schemaPath, 'utf-8'));
  db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(String(CURRENT_SCHEMA_VERSION));
  return {
    fromVersion: inferredVersion,
    toVersion: CURRENT_SCHEMA_VERSION,
    backupPath,
    migrated: inferredVersion < CURRENT_SCHEMA_VERSION,
  };
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  tableExists,
  getColumns,
  readSchemaVersion,
  inferSchemaVersion,
  initializeDatabase,
  migrateToV4,
  migrateToV5,
};
