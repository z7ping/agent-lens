const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { CURRENT_SCHEMA_VERSION, initializeDatabase, readSchemaVersion } = require('../server/migrations');
const { insertTimeline, upsertSession } = require('../server/agent-lens-db');

test('v0.3 数据库无损迁移并保留并行事件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lens-migrate-'));
  const dbPath = path.join(dir, 'agent-lens.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY, project_key TEXT, source TEXT, start_time TEXT,
      end_time TEXT, tool_count INTEGER, error_count INTEGER, total_duration_ms INTEGER
    );
    CREATE TABLE timeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, session_id TEXT NOT NULL,
      timestamp TEXT NOT NULL, seq INTEGER, role TEXT NOT NULL, tool_name TEXT, content TEXT,
      tool_input TEXT, success INTEGER, exit_code INTEGER, duration_ms REAL,
      output_snippet TEXT, error_message TEXT, error_type TEXT, error_detail TEXT,
      project_key TEXT, parent_seq INTEGER, tool_use_id TEXT
    );
    INSERT INTO sessions VALUES ('same-session', 'p1', 'codex', '2026-08-10T00:00:00Z', '2026-08-10T00:00:01Z', 1, 0, 10);
    INSERT INTO timeline (source, session_id, timestamp, role, content, project_key)
      VALUES ('codex', 'same-session', '2026-08-10T00:00:00Z', 'user', '旧任务', 'p1');
    INSERT INTO timeline (source, session_id, timestamp, role, tool_name, success, project_key, tool_use_id)
      VALUES ('codex', 'same-session', '2026-08-10T00:00:01Z', 'tool_result', 'shell', 1, 'p1', 'call-existing');
  `);

  const result = initializeDatabase(db, { dbPath, schemaPath: path.join(__dirname, '..', 'server', 'schema.sql') });
  assert.equal(result.migrated, true);
  assert.equal(readSchemaVersion(db), CURRENT_SCHEMA_VERSION);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM timeline').get().count, 2);
  assert.equal(db.prepare('SELECT session_key FROM sessions').get().session_key, 'codex:same-session');
  assert.equal(db.prepare('SELECT capture_method FROM timeline').get().capture_method, 'legacy_import');
  assert.ok(result.backupPath && fs.existsSync(result.backupPath));

  const reimport = insertTimeline({
    source: 'codex', session_id: 'same-session', timestamp: '2026-08-10T00:00:01Z',
    role: 'tool_result', source_event_id: 'call-existing', call_id: 'call-existing',
    tool_name: 'shell', success: true, capture_method: 'native_log',
  }, db);
  assert.equal(reimport.changes, 0, '迁移后的原生调用 ID 应与重新导入保持幂等');

  const timestamp = '2026-08-11T00:00:00.000Z';
  const first = insertTimeline({ source: 'codex', session_id: 'parallel', timestamp, role: 'assistant', source_sequence: 10, content: 'A', capture_method: 'native_log' }, db);
  const second = insertTimeline({ source: 'codex', session_id: 'parallel', timestamp, role: 'assistant', source_sequence: 11, content: 'B', capture_method: 'native_log' }, db);
  assert.equal(first.changes, 1);
  assert.equal(second.changes, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM timeline WHERE session_id='parallel'").get().count, 2);

  const duplicate = insertTimeline({ source: 'codex', session_id: 'parallel', timestamp, role: 'assistant', source_sequence: 10, content: 'A2', capture_method: 'native_log' }, db);
  assert.equal(duplicate.changes, 0);
  assert.equal(db.prepare("SELECT content FROM timeline WHERE session_id='parallel' AND source_sequence=10").get().content, 'A2');

  insertTimeline({
    source: 'codex', session_id: 'privacy', timestamp, role: 'user', source_sequence: 1,
    content: 'api_key=database-secret-value', tool_input: { authorization: 'Bearer hidden-token' },
    capture_method: 'native_log',
  }, db);
  const privateRow = db.prepare("SELECT content, tool_input, redaction_applied FROM timeline WHERE session_id='privacy'").get();
  assert.doesNotMatch(privateRow.content, /database-secret-value/);
  assert.doesNotMatch(privateRow.tool_input, /hidden-token/);
  assert.equal(privateRow.redaction_applied, 1);

  upsertSession({ source: 'codex', session_id: 'shared', tool_count: 1 }, db);
  upsertSession({ source: 'claude-code', session_id: 'shared', tool_count: 2 }, db);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE session_id='shared'").get().count, 2);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('拒绝用旧程序打开未来版本数据库', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES ('schema_version', '99');");
  assert.throws(
    () => initializeDatabase(db, { schemaPath: path.join(__dirname, '..', 'server', 'schema.sql') }),
    /高于当前程序支持/,
  );
  db.close();
});
