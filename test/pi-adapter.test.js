const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PiAdapter = require('../server/adapters/pi');
const { readCompleteLines } = require('../server/adapters/pi');

function writeJsonl(filePath, entries, trailingNewline = true) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, entries.map(entry => JSON.stringify(entry)).join('\n') + (trailingNewline ? '\n' : ''));
}

function fixtureEntries(parentSession) {
  return [
    { type: 'session', version: 3, id: 'session-child', timestamp: '2026-08-13T00:00:00.000Z', cwd: 'F:/workspace/pi', parentSession },
    { type: 'model_change', id: 'model-1', parentId: null, timestamp: '2026-08-13T00:00:01.000Z', provider: 'openai', modelId: 'gpt-test' },
    { type: 'thinking_level_change', id: 'think-1', parentId: 'model-1', timestamp: '2026-08-13T00:00:02.000Z', thinkingLevel: 'high' },
    { type: 'message', id: 'user-1', parentId: 'think-1', timestamp: '2026-08-13T00:00:03.000Z', message: { role: 'user', content: '检查并行工具', timestamp: 1786579203000 } },
    {
      type: 'message', id: 'assistant-1', parentId: 'user-1', timestamp: '2026-08-13T00:00:04.000Z',
      message: {
        role: 'assistant', provider: 'openai', model: 'gpt-test', stopReason: 'toolUse',
        content: [
          { type: 'thinking', thinking: '不应进入普通回复正文' },
          { type: 'text', text: '开始检查' },
          { type: 'toolCall', id: 'call-a', name: 'read', arguments: { path: 'a.js' } },
          { type: 'toolCall', id: 'call-b', name: 'bash', arguments: { command: 'npm test' } },
        ],
      },
    },
    { type: 'message', id: 'result-b', parentId: 'assistant-1', timestamp: '2026-08-13T00:00:05.000Z', message: { role: 'toolResult', toolCallId: 'call-b', toolName: 'bash', content: [{ type: 'text', text: 'ok-b' }], isError: false } },
    { type: 'message', id: 'result-a', parentId: 'result-b', timestamp: '2026-08-13T00:00:07.000Z', message: { role: 'toolResult', toolCallId: 'call-a', toolName: 'read', content: [{ type: 'text', text: 'ok-a' }], isError: false } },
    { type: 'compaction', id: 'compact-1', parentId: 'result-a', timestamp: '2026-08-13T00:00:08.000Z', summary: '压缩摘要', tokensBefore: 50000, retainedTail: [{ role: 'user', content: 'latest' }] },
    { type: 'branch_summary', id: 'branch-1', parentId: 'user-1', timestamp: '2026-08-13T00:00:09.000Z', fromId: 'compact-1', summary: '另一分支摘要' },
  ];
}

test('按 Pi 原生身份重建树形事件、派生 Session 和并行工具配对', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lens-pi-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, '--project--');
  const parentFile = path.join(projectDir, 'parent.jsonl');
  const childFile = path.join(projectDir, 'child.jsonl');
  writeJsonl(parentFile, [{ type: 'session', version: 3, id: 'session-parent', timestamp: '2026-08-12T00:00:00.000Z', cwd: 'F:/workspace/pi' }]);
  writeJsonl(childFile, fixtureEntries(parentFile));

  const adapter = new PiAdapter({ sessionsDir: root, importStateFile: path.join(root, 'state.json'), registerProject() {} });
  const records = await adapter.getRecords({ session_id: 'session-child', limit: 100 });
  const byType = (type) => records.filter(record => record.event_type === type);

  const sessionStart = byType('session_start')[0];
  assert.equal(sessionStart.attributes_json.parent_session_id, 'session-parent');
  assert.equal(sessionStart.attributes_json.session_version, 3);

  const assistant = byType('assistant')[0];
  assert.equal(assistant.content, '开始检查');
  assert.equal(assistant.attributes_json.thinking_present, true);
  assert.doesNotMatch(JSON.stringify(assistant), /不应进入普通回复正文/);

  assert.deepEqual(byType('tool_use').map(record => record.call_id).sort(), ['call-a', 'call-b']);
  const useA = records.find(record => record.call_id === 'call-a' && record.event_type === 'tool_use');
  const useB = records.find(record => record.call_id === 'call-b' && record.event_type === 'tool_use');
  const resultA = records.find(record => record.call_id === 'call-a' && record.event_type === 'tool_result');
  const resultB = records.find(record => record.call_id === 'call-b' && record.event_type === 'tool_result');
  assert.equal(resultA.parent_event_id, useA.event_id);
  assert.equal(resultB.parent_event_id, useB.event_id);
  assert.equal(resultA.duration_ms, 3000);
  assert.equal(resultB.duration_ms, 1000);
  assert.equal(resultA.turn_id, 'pi-turn:user-1');

  const compact = byType('compact_end')[0];
  assert.equal(compact.parent_event_id, resultA.event_id);
  assert.equal(compact.attributes_json.tokens_before, 50000);
  assert.equal(compact.attributes_json.retained_tail_count, 1);
  assert.equal(byType('branch_summary')[0].attributes_json.branch_from_entry_id, 'compact-1');
  assert.equal(byType('model_change')[0].attributes_json.model, 'gpt-test');
  assert.equal(byType('thinking_level_change')[0].attributes_json.thinking_level, 'high');
});

test('按字节偏移增量读取，保留不完整尾行并避免重复导入', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lens-pi-offset-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionFile = path.join(root, '--project--', 'session.jsonl');
  const stateFile = path.join(root, 'pi-state.json');
  const entries = fixtureEntries().slice(0, 4);
  writeJsonl(sessionFile, entries);

  const inserted = [];
  const recomputed = [];
  const db = {
    insertTimeline(record) { inserted.push(record); return { changes: 1 }; },
    updateDailyStats() {},
    recomputeSession(...args) { recomputed.push(args); },
  };
  const adapter = new PiAdapter({ sessionsDir: root, importStateFile: stateFile, db, registerProject() {} });
  await adapter._pollOnce();
  const firstCount = inserted.length;
  assert.deepEqual(inserted.map(record => record.source_event_id), [
    'session:session-child', 'model-1', 'think-1', 'user-1',
  ]);

  await adapter._pollOnce();
  assert.equal(inserted.length, firstCount);

  const partial = fixtureEntries()[4];
  fs.appendFileSync(sessionFile, JSON.stringify(partial));
  const beforePartial = readCompleteLines(sessionFile, JSON.parse(fs.readFileSync(stateFile, 'utf8')).files[adapter._fileStateKey(sessionFile)].offset);
  assert.equal(beforePartial.lines.length, 0);
  await adapter._pollOnce();
  assert.equal(inserted.length, firstCount);

  fs.appendFileSync(sessionFile, '\n');
  await adapter._pollOnce();
  const appended = inserted.slice(firstCount);
  assert.deepEqual(appended.map(record => record.event_type), ['assistant', 'tool_use', 'tool_use']);
  assert.deepEqual(appended.filter(record => record.event_type === 'tool_use').map(record => record.call_id), ['call-a', 'call-b']);
  assert.doesNotMatch(fs.readFileSync(stateFile, 'utf8'), /npm test|a\.js/);
  assert.ok(recomputed.some(args => args[0] === 'pi' && args[1] === 'session-child'));
});
