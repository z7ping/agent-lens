const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CODEX_LIFECYCLE_EVENT_TYPES,
  buildCodexLifecycleRecord,
  neutralHookOutput,
} = require('../server/codex-lifecycle');
const { handleRawInput } = require('../server/hooks/codex-lifecycle');
const { insertTimeline, queryTimeline } = require('../server/agent-lens-db');
const { initializeDatabase } = require('../server/migrations');
const BaseAdapter = require('../server/adapters/base');
const Database = require('better-sqlite3');

test('maps every supported Codex lifecycle hook to a normalized event', () => {
  for (const [hookEventName, eventType] of Object.entries(CODEX_LIFECYCLE_EVENT_TYPES)) {
    const record = buildCodexLifecycleRecord({
      hook_event_name: hookEventName,
      session_id: 'session-1',
      turn_id: 'turn-1',
      agent_id: 'agent-1',
      agent_transcript_path: 'C:/private/subagent.jsonl',
      last_assistant_message: '完成',
      source_event_id: `fixture-${hookEventName}`,
    }, { projectKey: 'project-1' });
    assert.equal(record.event_type, eventType);
    assert.equal(record.session_id, 'session-1');
    assert.equal(record.turn_id, 'turn-1');
    assert.equal(record.capture_method, 'runtime_hook');
    assert.doesNotMatch(JSON.stringify(record), /private\/subagent/);
  }
});

test('captures prompt and lifecycle attributes without persisting transcript paths', () => {
  const record = buildCodexLifecycleRecord({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'session-1',
    turn_id: 'turn-1',
    cwd: 'F:/project',
    transcript_path: 'C:/private/root.jsonl',
    model: 'gpt-test',
    permission_mode: 'plan',
    prompt: '请检查这段代码',
    source_event_id: 'fixture-prompt',
  });
  assert.equal(record.event_type, 'user_prompt');
  assert.equal(record.content, '请检查这段代码');
  assert.deepEqual(record.attributes_json, {
    hook_event_name: 'UserPromptSubmit',
    model: 'gpt-test',
    permission_mode: 'plan',
    transcript_available: true,
  });
  assert.doesNotMatch(JSON.stringify(record), /private\/root/);
});

test('records explicit missing reasons for incomplete subagent stop payloads', () => {
  const record = buildCodexLifecycleRecord({
    hook_event_name: 'SubagentStop',
    session_id: 'session-1',
    turn_id: 'turn-1',
    agent_id: 'agent-1',
    source_event_id: 'fixture-agent-stop',
  });
  assert.match(record.missing_reason, /transcript/);
  assert.match(record.missing_reason, /助手消息/);
  assert.equal(record.attributes_json.agent_transcript_available, false);
});

test('returns neutral JSON only for Stop and SubagentStop', async () => {
  assert.equal(neutralHookOutput('SessionStart'), '');
  assert.equal(neutralHookOutput('Stop'), '{}');
  assert.equal(neutralHookOutput('SubagentStop'), '{}');

  const seen = [];
  const adapter = { lifecycle: async data => seen.push(data.hook_event_name) };
  assert.equal(await handleRawInput(JSON.stringify({ hook_event_name: 'Stop' }), adapter), '{}');
  assert.deepEqual(seen, ['Stop']);
  assert.equal(await handleRawInput('{"hook_event_name":"SubagentStop",bad', adapter), '{}');
});

test('persists lifecycle events as independently queryable Schema v5 rows', () => {
  const db = new Database(':memory:');
  initializeDatabase(db);
  for (const [index, hookEventName] of ['PreCompact', 'PermissionRequest', 'Stop'].entries()) {
    const record = buildCodexLifecycleRecord({
      hook_event_name: hookEventName,
      session_id: 'session-queryable',
      turn_id: 'turn-queryable',
      source_event_id: `fixture-queryable-${index}`,
      tool_name: hookEventName === 'PermissionRequest' ? 'Bash' : undefined,
      tool_input: hookEventName === 'PermissionRequest' ? { command: 'npm test' } : undefined,
      last_assistant_message: hookEventName === 'Stop' ? '完成' : undefined,
    });
    assert.equal(insertTimeline(record, db).changes, 1);
  }
  const rows = queryTimeline({ session_id: 'session-queryable' }, db);
  assert.deepEqual(rows.map(row => row.event_type), ['compact_start', 'permission_request', 'turn_stop']);
  assert.equal(JSON.parse(rows[1].attributes_json).hook_event_name, 'PermissionRequest');
  db.close();
});

test('matches concurrent tool results by native call id instead of stack order', () => {
  const adapter = new BaseAdapter();
  const state = {
    stack: [
      { call_id: 'call-a', seq: 1 },
      { call_id: 'call-b', seq: 2 },
    ],
  };
  assert.equal(adapter.popFromStack(state, 'call-a').seq, 1);
  assert.deepEqual(state.stack.map(entry => entry.call_id), ['call-b']);
  assert.equal(adapter.popFromStack(state, 'missing'), null);
  assert.deepEqual(state.stack.map(entry => entry.call_id), ['call-b']);
});
