#!/usr/bin/env node
/**
 * 验证 v0.4 统一事件数据库的身份约束与 JSONL 可追溯性。
 *
 * 用法：node server/scripts/verify-integrity.js
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getRuntimePaths } = require('../runtime-paths');

const runtimePaths = getRuntimePaths({ baseDir: path.join(__dirname, '..') });

function readJsonlRecords() {
  if (!fs.existsSync(runtimePaths.logsDir)) return { files: 0, records: [], invalid: 0 };
  const names = fs.readdirSync(runtimePaths.logsDir).filter(name => name.endsWith('.jsonl'));
  const records = [];
  let invalid = 0;
  for (const name of names) {
    const lines = fs.readFileSync(path.join(runtimePaths.logsDir, name), 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try { records.push(JSON.parse(line)); } catch (_) { invalid += 1; }
    }
  }
  return { files: names.length, records, invalid };
}

function main() {
  if (!fs.existsSync(runtimePaths.dbFile)) throw new Error('agent-lens.db 不存在。');
  const db = new Database(runtimePaths.dbFile, { readonly: true });
  const schemaVersion = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()?.value;
  const duplicateEvents = db.prepare('SELECT COUNT(*) AS count FROM (SELECT event_id FROM timeline GROUP BY event_id HAVING COUNT(*) > 1)').get().count;
  const duplicateSessions = db.prepare('SELECT COUNT(*) AS count FROM (SELECT source, session_id FROM sessions GROUP BY source, session_id HAVING COUNT(*) > 1)').get().count;
  const brokenParents = db.prepare(`
    SELECT COUNT(*) AS count
    FROM timeline child
    LEFT JOIN timeline parent ON parent.event_id = child.parent_event_id
    WHERE child.parent_event_id IS NOT NULL AND parent.event_id IS NULL
  `).get().count;
  const missingEvidence = db.prepare(`
    SELECT COUNT(*) AS count FROM timeline
    WHERE capture_method IS NULL OR visibility IS NULL OR confidence IS NULL
  `).get().count;

  const jsonl = readJsonlRecords();
  let matched = 0;
  for (const record of jsonl.records) {
    const role = record.role === 'tool_error' || record.success === false ? 'tool_error' : 'tool_result';
    const found = db.prepare(`
      SELECT 1 FROM timeline
      WHERE source = ? AND session_id = ? AND event_type = ?
        AND timestamp = ? AND COALESCE(tool_name, '') = ?
      LIMIT 1
    `).get(
      String(record.source || 'unknown'),
      String(record.session_id || ''),
      role,
      record.ts || record.timestamp || '',
      String(record.tool_name || ''),
    );
    if (found) matched += 1;
  }

  db.close();
  console.log(`Schema 版本：${schemaVersion || '未知'}`);
  console.log(`JSONL：${jsonl.files} 个文件，${jsonl.records.length} 条可解析，${jsonl.invalid} 条无效，${matched} 条可追溯到 Timeline。`);
  console.log(`约束检查：事件重复 ${duplicateEvents}，会话身份重复 ${duplicateSessions}，断链父事件 ${brokenParents}，缺失证据元数据 ${missingEvidence}。`);

  const passed = schemaVersion === '4'
    && duplicateEvents === 0
    && duplicateSessions === 0
    && brokenParents === 0
    && missingEvidence === 0
    && matched === jsonl.records.length;
  if (!passed) {
    console.error('数据完整性验证失败。');
    process.exitCode = 1;
    return;
  }
  console.log('数据完整性验证通过。');
}

try {
  main();
} catch (error) {
  console.error(`验证失败：${error.message}`);
  process.exitCode = 1;
}
