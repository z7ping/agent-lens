const test = require('node:test');
const assert = require('node:assert/strict');

const HermesAdapter = require('../server/adapters/hermes');

test('builds Hermes user messages as conversation records', () => {
  const adapter = new HermesAdapter();
  const record = adapter._buildRecordFromMessage({
    session_id: 's1',
    role: 'user',
    timestamp: 1785923573.136951,
    content: '帮我配置 Pi',
    cwd: 'F:/proj',
  });

  assert.equal(record.source, 'hermes');
  assert.equal(record.session_id, 's1');
  assert.equal(record.role, 'user');
  assert.equal(record.content, '帮我配置 Pi');
  assert.equal(record.success, null);
});

test('builds Hermes assistant messages as conversation records', () => {
  const adapter = new HermesAdapter();
  const record = adapter._buildRecordFromMessage({
    session_id: 's1',
    role: 'assistant',
    timestamp: 1785923609.8326557,
    content: '我先检查配置。',
    cwd: 'F:/proj',
  });

  assert.equal(record.role, 'assistant');
  assert.equal(record.content, '我先检查配置。');
  assert.equal(record.success, null);
});

test('builds Hermes tool messages with assistant tool metadata', () => {
  const adapter = new HermesAdapter();
  const record = adapter._buildRecordFromMessage({
    session_id: 's1',
    role: 'tool',
    timestamp: 1785923612.7649813,
    content: JSON.stringify({ output: 'ok', exit_code: 0, error: null }),
    tool_call_id: 'call_1',
    cwd: 'F:/proj',
  }, {
    get: () => ({
      timestamp: 1785923609.8326557,
      tool_calls: JSON.stringify([
        { id: 'call_1', function: { name: 'terminal', arguments: JSON.stringify({ command: 'echo ok' }) } },
      ]),
    }),
  });

  assert.equal(record.role, 'tool_result');
  assert.equal(record.tool_name, 'terminal');
  assert.deepEqual(record.input_summary, { command: 'echo ok' });
  assert.equal(record.success, true);
  assert.equal(record.duration_ms, 2932);
});
