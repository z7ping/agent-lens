import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceRecord } from '@agent-lens/core'
import { normalizeCurrentCodexRecord } from './current-protocol'

const ctx = {
  host: { id: 'host', name: 'host', platform: 'linux', arch: 'x64', createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z' },
  installation: { id: 'install', hostId: 'host', productId: 'codex', firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z' },
} as any

function record(payload: Record<string, unknown>, sourceSequence: number): SourceRecord {
  return {
    id: `persisted-legacy-${sourceSequence}`,
    sourceId: 'codex',
    installationId: 'install',
    sourceSessionNativeId: 'thread-root',
    nativeType: 'rollout',
    sourceSequence,
    occurredAt: '2026-09-05T09:00:00.000Z',
    capturedAt: '2026-09-05T09:00:01.000Z',
    locator: { kind: 'file', path: '/safe/rollout.jsonl', offset: sourceSequence },
    payload: {
      entry: { type: 'event_msg', payload },
      session: { nativeSessionId: 'thread-root', cwd: '/safe/project' },
    },
    parserVersion: '19',
  }
}

test('official persisted legacy EventMsg variants do not degrade to unknown', async () => {
  const cases: Array<{ payload: Record<string, unknown>; kind: string; event?: string }> = [
    {
      payload: { type: 'entered_review_mode', target: { type: 'uncommittedChanges' }, user_facing_hint: 'reviewing' },
      kind: 'session.lifecycle',
      event: 'review.entered',
    },
    {
      payload: { type: 'exited_review_mode', review_output: { overall_explanation: 'done' } },
      kind: 'session.lifecycle',
      event: 'review.exited',
    },
    {
      payload: { type: 'patch_apply_end', call_id: 'patch-1', success: true, status: 'completed', changes: { 'a.ts': { type: 'update' } }, stdout: '', stderr: '' },
      kind: 'artifact.action',
    },
    {
      payload: { type: 'mcp_tool_call_end', call_id: 'mcp-1', invocation: { server: 'docs', tool: 'read', arguments: {} }, result: { Ok: { content: [], is_error: false } } },
      kind: 'tool.result',
    },
    {
      payload: { type: 'web_search_end', call_id: 'web-1', query: 'AgentLens', action: { type: 'search', query: 'AgentLens' }, results: [] },
      kind: 'tool.result',
    },
    {
      payload: { type: 'image_generation_end', call_id: 'image-1', status: 'completed', revised_prompt: 'diagram', result: 'image-bytes', saved_path: '/safe/image.png' },
      kind: 'artifact.action',
    },
    {
      payload: { type: 'subagent_activity', event_id: 'sub-1', kind: 'started', agent_thread_id: 'thread-worker', agent_path: '/root/worker' },
      kind: 'subagent.spawn',
    },
    {
      payload: { type: 'subagent_activity', event_id: 'sub-2', kind: 'interacted', agent_thread_id: 'thread-worker', agent_path: '/root/worker' },
      kind: 'session.lifecycle',
      event: 'subagent.interacted',
    },
    {
      payload: { type: 'subagent_activity', event_id: 'sub-3', kind: 'interrupted', agent_thread_id: 'thread-worker', agent_path: '/root/worker' },
      kind: 'subagent.end',
    },
  ]

  for (const [index, value] of cases.entries()) {
    const output = await normalizeCurrentCodexRecord(record(value.payload, index + 1), ctx)
    assert.equal(output.observations.some(item => item.kind === 'unknown'), false, String(value.payload.type))
    assert.equal(output.observations[0]?.kind, value.kind, String(value.payload.type))
    if (value.event) assert.equal((output.observations[0]?.payload as any).event, value.event)
  }
})

test('legacy persisted tool results retain native call identity', async () => {
  for (const [index, payload] of [
    { type: 'mcp_tool_call_end', call_id: 'mcp-1', invocation: { server: 'docs', tool: 'read' }, result: { Ok: { is_error: false } } },
    { type: 'web_search_end', call_id: 'web-1', query: 'AgentLens', action: { type: 'search', query: 'AgentLens' }, results: [] },
  ].entries()) {
    const output = await normalizeCurrentCodexRecord(record(payload, 20 + index), ctx)
    assert.equal(output.observations[0]?.nativeCallId, payload.call_id)
    assert.equal(output.observations[0]?.dedupHints?.nativeCallId, payload.call_id)
  }
})

test('future persisted EventMsg still stays unknown instead of guessing semantics', async () => {
  const output = await normalizeCurrentCodexRecord(record({
    type: 'future_persisted_event',
    future: { survives: true },
  }, 40), ctx)

  assert.equal(output.observations[0]?.kind, 'unknown')
  assert.equal((output.observations[0]?.payload as any).rawPayload.payload.future.survives, true)
})
