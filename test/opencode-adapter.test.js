const test = require('node:test');
const assert = require('node:assert/strict');

const OpenCodeAdapter = require('../server/adapters/opencode');

test('builds OpenCode user text parts as conversation records', () => {
  const adapter = new OpenCodeAdapter();

  const record = adapter._buildRecord({
    session_id: 'ses_1',
    time_created: 1786085000000,
    directory: 'F:/01-ai-gen-workspaces/agent-lens',
    data: JSON.stringify({ type: 'text', text: '请检查 OpenCode 数据为什么没有对话' }),
    message_data: JSON.stringify({ role: 'user' }),
  });

  assert.equal(record.source, 'opencode');
  assert.equal(record.session_id, 'ses_1');
  assert.equal(record.role, 'user');
  assert.equal(record.content, '请检查 OpenCode 数据为什么没有对话');
  assert.equal(record.success, null);
  assert.equal(record.tool_name, undefined);
});

test('builds OpenCode assistant text parts as conversation records', () => {
  const adapter = new OpenCodeAdapter();

  const record = adapter._buildRecord({
    session_id: 'ses_1',
    time_created: 1786085001000,
    directory: 'F:/01-ai-gen-workspaces/agent-lens',
    data: JSON.stringify({ type: 'text', text: '我会先检查源数据库结构。' }),
    message_data: JSON.stringify({ role: 'assistant' }),
  });

  assert.equal(record.role, 'assistant');
  assert.equal(record.content, '我会先检查源数据库结构。');
  assert.equal(record.success, null);
});
