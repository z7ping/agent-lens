import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceRecord } from '@agent-lens/core'
import { normalizeCodexRecord } from './normalize'

const ctx = {
  host: { id: 'host', name: 'host', platform: 'linux', arch: 'x64', createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z' },
  installation: { id: 'install', hostId: 'host', productId: 'codex', firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z' },
} as any

function record(entry: unknown, nativeType = 'rollout'): SourceRecord {
  return {
    id: `r-${Math.random()}`,
    sourceId: 'codex',
    installationId: 'install',
    sourceSessionNativeId: 'thread-child',
    nativeType,
    sourceSequence: 1,
    capturedAt: '2026-08-31T00:00:00.000Z',
    locator: { kind: 'file', path: '/safe/rollout.jsonl', offset: 0 },
    payload: { entry, session: { nativeSessionId: 'thread-child', cwd: '/safe/project' } },
    parserVersion: '5',
  }
}

test('session_meta preserves official thread and agent lineage', async () => {
  const output = await normalizeCodexRecord(record({
    type: 'session_meta',
    payload: {
      id: 'thread-child', parent_thread_id: 'thread-parent', forked_from_id: 'thread-root',
      agent_role: 'subagent', agent_nickname: 'reviewer', agent_path: 'agent/reviewer',
      source: 'cli', thread_source: 'subagent', model_provider: 'openai', model_context_window: 200000,
      future_field: { survives: true },
    },
  }), ctx)
  assert.equal(output.observations[0]?.kind, 'session.lifecycle')
  assert.equal((output.observations[0]?.payload as any).future_field.survives, true)
  assert.equal(output.observations[0]?.identityHints.nativeParentSessionId, 'thread-root')
  assert.equal(output.observations[0]?.identityHints.nativeActorId, 'agent/reviewer')
  assert.equal(output.observations[0]?.identityHints.actorRole, 'subagent')
  assert.equal(output.sessionRelationshipHints?.[0]?.type, 'branch-task')
  assert.equal(output.sessionRelationshipHints?.[0]?.fromNativeSessionId, 'thread-root')
})

test('turn_context is a readable lifecycle fact with model/workspace identity', async () => {
  const output = await normalizeCodexRecord(record({
    type: 'turn_context',
    payload: { model: 'gpt-5', cwd: '/safe/project', sandbox_policy: 'workspace-write', approval_policy: 'on-request', reasoning_effort: 'high', collaboration_mode: 'default' },
  }), ctx)
  const fact = output.observations[0]!
  assert.equal(fact.kind, 'session.lifecycle')
  assert.equal((fact.payload as any).event, 'turn.context')
  assert.equal(fact.identityHints.modelName, 'gpt-5')
  assert.equal(fact.identityHints.workspacePath, '/safe/project')
})

test('event_msg token_count becomes canonical usage', async () => {
  const output = await normalizeCodexRecord(record({
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 30, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 } } },
  }), ctx)
  const fact = output.observations[0]!
  assert.equal(fact.kind, 'usage')
  assert.equal((fact.payload as any).inputTokens, 100)
  assert.equal((fact.payload as any).cacheReadTokens, 30)
  assert.equal((fact.payload as any).outputTokens, 20)
  assert.equal((fact.payload as any).totalTokens, 120)
})

test('compacted, web search and future rollout items retain source-visible detail', async () => {
  const compacted = await normalizeCodexRecord(record({ type: 'compacted', payload: { replacement_history: ['a'], reason: 'auto' } }), ctx)
  assert.equal(compacted.observations[0]?.kind, 'context.compaction')

  const web = await normalizeCodexRecord(record({ type: 'response_item', payload: { type: 'web_search_call', call_id: 'w1', status: 'completed', action: { type: 'search', query: 'AgentLens', domains: ['github.com'] } } }), ctx)
  assert.equal(web.observations[0]?.kind, 'tool.call')
  assert.deepEqual((web.observations[0]?.payload as any).input.action.domains, ['github.com'])
  assert.equal((web.observations[0]?.payload as any).input.status, 'completed')

  const unknown = await normalizeCodexRecord(record({ type: 'future_rollout_item', payload: { future: { survives: true } } }, 'future_rollout_item'), ctx)
  assert.equal(unknown.observations[0]?.kind, 'unknown')
  assert.equal((unknown.observations[0]?.payload as any).rawPayload.payload.future.survives, true)
})
