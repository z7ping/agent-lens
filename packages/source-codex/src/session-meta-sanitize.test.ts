import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeCodexEntry } from './format'

test('session_meta sanitizer preserves structural attribution fields without leaking secrets', () => {
  const sanitized = sanitizeCodexEntry({
    timestamp: '2026-09-05T08:30:00.000Z',
    type: 'session_meta',
    payload: {
      id: 'child-thread',
      session_id: 'shared-session',
      cwd: '/safe/project',
      originator: 'codex_cli_rs',
      cli_version: '0.test',
      parent_thread_id: 'root-thread',
      forked_from_id: null,
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: 'root-thread',
            agent_nickname: 'worker-1',
            api_token: 'must-not-leak',
          },
        },
      },
      thread_source: 'subagent',
      agent_role: 'worker',
      model_provider: 'openai',
      history_mode: 'paginated',
      subagent_history_start_ordinal: 42,
      base_instructions: 'do not persist this prompt',
    },
  })

  const payload = sanitized.payload as Record<string, any>
  assert.equal(payload.id, 'child-thread')
  assert.equal(payload.session_id, 'shared-session')
  assert.equal(payload.parent_thread_id, 'root-thread')
  assert.equal(payload.thread_source, 'subagent')
  assert.equal(payload.agent_role, 'worker')
  assert.equal(payload.history_mode, 'paginated')
  assert.equal(payload.subagent_history_start_ordinal, 42)
  assert.equal(payload.source.subagent.thread_spawn.parent_thread_id, 'root-thread')
  assert.equal(payload.source.subagent.thread_spawn.api_token, '[redacted]')
  assert.equal(payload.base_instructions, undefined)
})
