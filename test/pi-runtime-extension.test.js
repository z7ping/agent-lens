const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  agentLensPiExtension,
  buildPiHostRuntimeEvent,
  buildPiRuntimeEventPayload,
  normalizePiSessionId,
  normalizeRuntimeEventType,
  registerPiRuntimeExtension,
  resolveHookToken,
  resolveHookUrl,
} = require('../server/hooks/pi-runtime-extension');

test('normalizes Pi runtime event aliases into AgentLens payloads', () => {
  const payload = buildPiRuntimeEventPayload({
    type: 'tool_call',
    session_id: 'pi-session',
    call_id: 'call-1',
    tool_name: 'Shell',
  }, {
    cwd: 'F:/workspace/agent',
  });

  assert.equal(payload.source, 'pi');
  assert.equal(payload.event_type, 'tool_use');
  assert.equal(payload.tool_call_id, 'call-1');
  assert.equal(payload.cwd, 'F:/workspace/agent');
  assert.match(payload.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(normalizeRuntimeEventType({ type: 'session_end' }), 'session_end');
  assert.equal(normalizeRuntimeEventType({ type: 'before_agent_start' }), 'user_prompt');
  assert.equal(normalizeRuntimeEventType({ type: 'assistant_message' }), 'assistant');
});

test('builds AgentLens payloads from Pi native host events', () => {
  const sessionFile = 'C:/Users/test/.pi/agent/sessions/project/2026-08-14T10-00-00-000Z_019fff88-2829-79a1-9bff-2fc48d9faf3b.jsonl';
  const payload = buildPiHostRuntimeEvent('tool_result', {
    id: 'result-1',
    toolCallId: 'call-1',
    toolName: 'bash',
    isError: true,
    output: 'failed',
    durationMs: 123,
  }, {
    cwd: 'F:/workspace/agent-lens',
    sessionManager: {
      getSessionFile: () => sessionFile,
    },
  }, {
    extension_version: '0.7.0-test',
  });

  assert.equal(payload.source, 'pi');
  assert.equal(payload.event_type, 'tool_error');
  assert.equal(payload.native_event_type, 'tool_result');
  assert.equal(payload.session_id, '019fff88-2829-79a1-9bff-2fc48d9faf3b');
  assert.equal(payload.tool_call_id, 'call-1');
  assert.equal(payload.tool_name, 'bash');
  assert.equal(payload.success, false);
  assert.equal(payload.duration_ms, 123);
  assert.equal(payload.attributes.pi_native_event, 'tool_result');
});

test('normalizes Pi session identifiers from paths and prefixed ids', () => {
  assert.equal(
    normalizePiSessionId('pi:019fff88-2829-79a1-9bff-2fc48d9faf3b'),
    '019fff88-2829-79a1-9bff-2fc48d9faf3b'
  );
  assert.equal(
    normalizePiSessionId('C:/tmp/2026-08-14T10-00-00-000Z_019fff88-2829-79a1-9bff-2fc48d9faf3b.jsonl'),
    '019fff88-2829-79a1-9bff-2fc48d9faf3b'
  );
});

test('resolves hook endpoint and token from explicit options or installed runtime files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lens-pi-hook-'));
  const runDir = path.join(root, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'hook-token'), 'token-from-file\n');

  assert.equal(resolveHookUrl({ port: 60123 }), 'http://127.0.0.1:60123/api/hook');
  assert.equal(resolveHookToken({ rootDir: root }), 'token-from-file');
  assert.equal(resolveHookToken({ token: 'explicit-token', rootDir: root }), 'explicit-token');
});

test('registers passive Pi runtime listeners when the host exposes an event API', () => {
  const handlers = {};
  const api = {
    on(eventName, handler) {
      handlers[eventName] = handler;
    },
  };

  const result = registerPiRuntimeExtension(api, {
    token: 'token',
    url: 'http://127.0.0.1:1/api/hook',
    events: ['session_start', 'tool_call'],
  });

  assert.deepEqual(result, { registered: true, events: ['session_start', 'tool_call'] });
  assert.equal(typeof handlers.session_start, 'function');
  assert.equal(typeof handlers.tool_call, 'function');
  assert.deepEqual(registerPiRuntimeExtension(null), { registered: false, reason: 'missing_event_api' });
});

test('default Pi extension entry registers native host events', () => {
  const registered = [];
  agentLensPiExtension({
    on(eventName, handler) {
      registered.push([eventName, typeof handler]);
    },
  });

  assert.deepEqual(registered.map(item => item[0]), [
    'session_start',
    'before_agent_start',
    'agent_end',
    'session_before_compact',
    'session_compact',
    'session_shutdown',
    'tool_call',
    'tool_result',
  ]);
  assert.ok(registered.every(item => item[1] === 'function'));
});
