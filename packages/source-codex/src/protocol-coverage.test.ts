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
  assert.equal(output.sessionRelationshipHints?.[0]?.type, 'fork')
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

test('persisted thread settings becomes a readable reasoning configuration lifecycle fact', async () => {
  const output = await normalizeCodexRecord(record({
    type: 'event_msg',
    payload: {
      type: 'thread_settings_applied',
      model: 'gpt-5.6-sol',
      reasoning_effort: 'high',
      reasoning_summary: 'auto',
    },
  }), ctx)
  const fact = output.observations[0]!
  assert.equal(fact.kind, 'session.lifecycle')
  assert.equal((fact.payload as any).event, 'reasoning.configuration.updated')
  assert.equal((fact.payload as any).reasoning_effort, 'high')
})

test('persisted agent communication becomes a readable lifecycle fact', async () => {
  const response = await normalizeCodexRecord(record({
    type: 'response_item',
    payload: {
      type: 'agent_message',
      author: '/root/worker',
      recipient: '/root',
      content: [{ type: 'output_text', text: 'child done' }],
    },
  }), ctx)
  assert.equal(response.observations[0]?.kind, 'session.lifecycle')
  assert.equal((response.observations[0]?.payload as any).event, 'subagent.communication')
  assert.equal((response.observations[0]?.payload as any).text, 'child done')

  const rollout = await normalizeCodexRecord(record({
    type: 'inter_agent_communication',
    payload: {
      author: '/root',
      recipient: '/root/worker',
      content: 'please inspect this',
      trigger_turn: true,
    },
  }), ctx)
  assert.equal(rollout.observations[0]?.kind, 'session.lifecycle')
  assert.equal((rollout.observations[0]?.payload as any).event, 'subagent.communication')
  assert.equal((rollout.observations[0]?.payload as any).text, 'please inspect this')
})

test('persisted local shell and tool search calls become canonical tool calls', async () => {
  const shell = await normalizeCodexRecord(record({
    type: 'response_item',
    payload: {
      type: 'local_shell_call',
      call_id: 'shell-1',
      status: 'completed',
      action: { type: 'exec', command: ['git', 'status'], working_directory: '/safe/project' },
    },
  }), ctx)
  assert.equal(shell.observations[0]?.kind, 'tool.call')
  assert.equal((shell.observations[0]?.payload as any).nativeToolName, 'local_shell')
  assert.deepEqual((shell.observations[0]?.payload as any).input.command, ['git', 'status'])

  const search = await normalizeCodexRecord(record({
    type: 'response_item',
    payload: {
      type: 'tool_search_call',
      call_id: 'search-1',
      execution: 'server',
      status: 'completed',
      arguments: { query: 'review tool' },
    },
  }), ctx)
  assert.equal(search.observations[0]?.kind, 'tool.call')
  assert.equal((search.observations[0]?.payload as any).nativeToolName, 'tool_search')
  assert.equal((search.observations[0]?.payload as any).input.query, 'review tool')
})

test('persisted image generation becomes an artifact action without exposing the result body', async () => {
  const output = await normalizeCodexRecord(record({
    type: 'response_item',
    payload: {
      type: 'image_generation_call',
      id: 'image-1',
      status: 'completed',
      result: 'base64-image-data',
    },
  }), ctx)
  const fact = output.observations[0]!
  const payload = fact.payload as any
  assert.equal(fact.kind, 'artifact.action')
  assert.equal(payload.action, 'image.generation')
  assert.equal(payload.artifactId, 'image-1')
  assert.equal(payload.hasResult, true)
  assert.equal('result' in payload, false)
  assert.equal('raw' in payload, false)
})

test('persisted compaction response items become canonical compaction facts', async () => {
  for (const type of ['compaction', 'context_compaction']) {
    const output = await normalizeCodexRecord(record({
      type: 'response_item',
      payload: { type, encrypted_content: 'opaque', future_field: { survives: true } },
    }), ctx)
    assert.equal(output.observations[0]?.kind, 'context.compaction')
    assert.equal((output.observations[0]?.payload as any).sourceType, type)
    assert.equal((output.observations[0]?.payload as any).raw.future_field.survives, true)
  }
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
