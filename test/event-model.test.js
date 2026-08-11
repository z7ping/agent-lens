const test = require('node:test');
const assert = require('node:assert/strict');

const { makeSessionKey, makeEventId, normalizeEventRecord } = require('../server/event-model');

test('Session 内部主键按来源隔离', () => {
  assert.equal(makeSessionKey('codex', 'same-id'), 'codex:same-id');
  assert.equal(makeSessionKey('claude-code', 'same-id'), 'claude-code:same-id');
  assert.notEqual(makeSessionKey('codex', 'same-id'), makeSessionKey('claude-code', 'same-id'));
});

test('同一时间的并行事件使用来源顺序保留独立身份', () => {
  const common = { source: 'codex', session_id: 's1', timestamp: '2026-08-11T00:00:00.000Z', event_type: 'assistant', role: 'assistant' };
  const first = makeEventId({ ...common, source_sequence: 10 });
  const second = makeEventId({ ...common, source_sequence: 11 });
  assert.notEqual(first, second);
});

test('Tool Use 与 Tool Result 使用相同调用标识但不同事件身份', () => {
  const use = normalizeEventRecord({ source: 'codex', session_id: 's1', role: 'tool_use', call_id: 'call-1' });
  const result = normalizeEventRecord({ source: 'codex', session_id: 's1', role: 'tool_result', call_id: 'call-1' });
  assert.equal(use.call_id, result.call_id);
  assert.notEqual(use.event_id, result.event_id);
});

