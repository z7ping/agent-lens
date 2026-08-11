#!/usr/bin/env node
/**
 * 把 logs/*.jsonl 中的历史 Hook 记录导入 v0.4 统一事件模型。
 *
 * 用法：
 *   node server/scripts/migrate-jsonl.js
 *   node server/scripts/migrate-jsonl.js --dry-run
 *   node server/scripts/migrate-jsonl.js --force
 */

const fs = require('fs');
const path = require('path');
const { getRuntimePaths } = require('../runtime-paths');
const agentLensDb = require('../agent-lens-db');

const runtimePaths = getRuntimePaths({ baseDir: path.join(__dirname, '..') });
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');

function readJsonlFiles() {
  if (!fs.existsSync(runtimePaths.logsDir)) return [];
  return fs.readdirSync(runtimePaths.logsDir)
    .filter(name => name.endsWith('.jsonl'))
    .map(name => path.join(runtimePaths.logsDir, name));
}

function parseRecords(files) {
  const records = [];
  let invalid = 0;
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (!record.ts || !record.project_key) {
          invalid += 1;
          continue;
        }
        records.push(record);
      } catch (_) {
        invalid += 1;
      }
    }
  }
  return { records, invalid };
}

function resetImportedData(db) {
  db.exec(`
    BEGIN IMMEDIATE;
    DELETE FROM recent_errors;
    DELETE FROM daily_stats;
    DELETE FROM timeline;
    DELETE FROM sessions;
    DELETE FROM projects;
    DELETE FROM sqlite_sequence WHERE name IN ('recent_errors', 'timeline', 'projects');
    COMMIT;
  `);
}

function importRecords(db, records) {
  const upsertProject = db.prepare(`
    INSERT INTO projects (project_key, name, cwd, last_seen)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_key) DO UPDATE SET
      name = COALESCE(NULLIF(excluded.name, ''), name),
      cwd = COALESCE(NULLIF(excluded.cwd, ''), cwd),
      last_seen = MAX(last_seen, excluded.last_seen)
  `);
  const affectedSessions = new Map();
  let imported = 0;
  let existing = 0;

  for (const record of records) {
    const source = String(record.source || 'unknown');
    const sessionId = String(record.session_id || '');
    upsertProject.run(
      record.project_key,
      record.project_name || 'unknown',
      record.cwd || '',
      record.ts,
    );

    const role = record.role === 'tool_error' || record.success === false
      ? 'tool_error'
      : 'tool_result';
    const pair = agentLensDb.insertToolEventPair({
      ...record,
      source,
      session_id: sessionId,
      timestamp: record.ts,
      event_type: role,
      role,
      tool_input: record.tool_input ?? record.input_summary ?? null,
      error_message: record.error_message ?? record.error ?? null,
      source_sequence: record.source_sequence ?? record.seq ?? null,
      capture_method: record.capture_method || 'legacy_import',
      visibility: record.visibility || 'captured',
      confidence: record.confidence || 'unknown',
      missing_reason: record.missing_reason || 'JSONL 历史记录可能缺少独立 Tool Use 时间与原生事件标识',
      capture_policy: record.capture_policy || 'legacy_unknown',
    }, db);
    if (pair.resultInfo.changes > 0) {
      imported += 1;
      const date = String(record.ts).slice(0, 10);
      agentLensDb.updateDailyStats(date, source, record.tool_name || 'unknown', 1, role === 'tool_error' ? 1 : 0, record.duration_ms || 0, db);
      if (role === 'tool_error' && (record.error_message || record.error)) {
        agentLensDb.saveError(record.ts, sessionId, source, record.tool_name || 'unknown', record.error_message || record.error, db);
      }
    } else {
      existing += 1;
    }
    if (sessionId) affectedSessions.set(`${source}\u0000${sessionId}`, { source, sessionId, projectKey: record.project_key });
  }

  for (const { source, sessionId, projectKey } of affectedSessions.values()) {
    agentLensDb.recomputeSession(source, sessionId, projectKey, db);
  }
  return { imported, existing, sessions: affectedSessions.size };
}

function main() {
  const files = readJsonlFiles();
  if (files.length === 0) {
    console.log('没有找到可迁移的 JSONL 文件。');
    return;
  }
  const { records, invalid } = parseRecords(files);
  console.log(`发现 ${files.length} 个 JSONL 文件，${records.length} 条有效记录，${invalid} 条无效记录。`);
  if (dryRun) {
    console.log('预览完成：未修改数据库。');
    return;
  }

  const db = agentLensDb.getDb();
  if (!db) throw new Error('SQLite 后端不可用，请安装 better-sqlite3。');
  if (force) {
    console.log('已启用 --force，将重建 AgentLens 本地索引数据。');
    resetImportedData(db);
  }
  const result = importRecords(db, records);
  console.log(`迁移完成：新增 ${result.imported} 条结果事件，已有 ${result.existing} 条，涉及 ${result.sessions} 个会话。`);
  agentLensDb.closeDb();
}

try {
  main();
} catch (error) {
  console.error(`迁移失败：${error.message}`);
  try { agentLensDb.closeDb(); } catch (_) {}
  process.exitCode = 1;
}
