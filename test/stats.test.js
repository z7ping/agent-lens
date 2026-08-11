const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { queryStats, updateDailyStats, upsertSession } = require('../server/agent-lens-db');

function createDb() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'server', 'schema.sql'), 'utf8'));
  return db;
}

test('按调用数计算加权平均耗时，并按来源统计 Session', () => {
  const db = createDb();
  updateDailyStats('2026-08-11', 'codex', 'Read', 1, 0, 100, db);
  updateDailyStats('2026-08-11', 'codex', 'Read', 1, 1, 300, db);
  updateDailyStats('2026-08-12', 'codex', 'Read', 2, 0, 400, db);
  updateDailyStats('2026-08-11', 'hermes', 'Read', 1, 0, 900, db);

  upsertSession({ source: 'codex', session_id: 'same', start_time: '2026-08-11T01:00:00Z' }, db);
  upsertSession({ source: 'hermes', session_id: 'same', start_time: '2026-08-11T02:00:00Z' }, db);

  const codex = queryStats({ source: 'codex', since: '2026-08-11' }, db);
  assert.equal(codex.totals.total_calls, 4);
  assert.equal(codex.totals.total_errors, 1);
  assert.equal(codex.totals.session_count, 1);
  assert.equal(codex.byTool[0].avg_duration_ms, 300);

  const all = queryStats({}, db);
  assert.equal(all.totals.session_count, 2);
  db.close();
});
