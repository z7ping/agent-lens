import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceRecord } from '@agent-lens/core'
import { nativeIdForEntry, nativeTypeForEntry } from './format'
import { normalizePaginatedCodexRecord } from './paginated-protocol'

const ctx = {
  host: { id: 'host', name: 'host', platform: 'linux', arch: 'x64', createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z' },
  installation: { id: 'install', hostId: 'host', productId: 'codex', firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z' },
} as any

function itemCompleted(item: Record<string, unknown>, sequence = 1): SourceRecord {
  const entry = {
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: 'thread-root',
      turn_id: 'turn-1',
      item,
      started_at_ms: 0,
      completed_at_ms: 1,
    },
  }
  const nativeId = nativeIdForEntry(entry)
  return {
    id: `r-${sequence}`,
    sourceId: 'codex',
    installationId: 'install',
    sourceSessionNativeId: 'thread-root',
    nativeType: nativeTypeForEntry(entry),
    ...(nativeId ? { nativeId } : {}),
    sourceSequence: sequence,
    occurredAt: '2026-09-05T08:00:00.000Z',
    capturedAt: '2026-09-05T08:00:01.000Z',
    locator: { kind: 'file', path: '/safe/paginated.jsonl', offset: sequence },
    payload: { entry, session: { nativeSessionId: 'thread-root', cwd: '/safe/project' } },
    parserVersion: '15',
  }
}

test('Paginated UserMessage is a genuine user turn with item identity', async () => {
  const record = itemCompleted({
    type: 'UserMessage',
    id: 'user-item-1',
    client_id: 'client-1',
    content: [
      { type: 'text', text: '继续修复 Codex', text_elements: [] },
      { type: 'local_image', path: '/safe/screenshot.png' },
    ],
  })
  const output = await normalizePaginatedCodexRecord(record, ctx)
  assert.ok(output)
  const fact = output.observations[0]!
  assert.equal(fact.kind, 'message.user')
  assert.equal(fact.nativeEventId, 'user-item-1')
  assert.equal((fact.payload as any).text, '继续修复 Codex')
  assert.equal((fact.payload as any).provenance.actualAuthor, 'human-user')
  assert.equal((fact.payload as any).provenance.contentRole, 'user-request')
  assert.equal((fact.payload as any).provenance.sourceSignal, 'event_msg.item_completed.UserMessage')
  assert.equal((fact.payload as any).turnId, 'turn-1')
  assert.equal((fact.payload as any).attachments.length, 1)
})

test('Paginated AgentMessage is normal assistant output, not background unknown', async () => {
  const output = await normalizePaginatedCodexRecord(itemCompleted({
    type: 'AgentMessage',
    id: 'agent-item-1',
    content: [{ type: 'Text', text: '正常回复内容' }],
    phase: 'final_answer',
  }), ctx)
  assert.ok(output)
  const fact = output.observations[0]!
  assert.equal(fact.kind, 'message.assistant')
  assert.equal(fact.nativeEventId, 'agent-item-1')
  assert.equal((fact.payload as any).text, '正常回复内容')
  assert.equal((fact.payload as any).provenance.actualAuthor, 'assistant')
  assert.equal((fact.payload as any).provenance.activityType, 'conversation')
  assert.equal((fact.payload as any).provenance.sourceSignal, 'event_msg.item_completed.AgentMessage')
  assert.equal((fact.payload as any).turnId, 'turn-1')
})

test('Paginated Plan is assistant commentary rather than background unknown', async () => {
  const output = await normalizePaginatedCodexRecord(itemCompleted({
    type: 'Plan', id: 'plan-item-1', text: '先检查协议，再修改映射。',
  }), ctx)
  assert.ok(output)
  const fact = output.observations[0]!
  assert.equal(fact.kind, 'message.commentary')
  assert.equal(fact.nativeEventId, 'plan-item-1')
  assert.equal((fact.payload as any).text, '先检查协议，再修改映射。')
  assert.equal((fact.payload as any).plan, true)
  assert.equal((fact.payload as any).provenance.actualAuthor, 'assistant')
  assert.equal((fact.payload as any).provenance.sourceSignal, 'event_msg.item_completed.Plan')
})

test('Paginated HookPrompt stays application context and never becomes a user turn', async () => {
  const output = await normalizePaginatedCodexRecord(itemCompleted({
    type: 'HookPrompt', id: 'hook-item-1',
    fragments: [{ text: 'Injected by hook', hookRunId: 'hook-run-1' }],
  }), ctx)
  assert.ok(output)
  const fact = output.observations[0]!
  assert.equal(fact.kind, 'context.injected')
  assert.equal(fact.nativeEventId, 'hook-item-1')
  assert.equal((fact.payload as any).provenance.actualAuthor, 'application')
  assert.equal((fact.payload as any).provenance.contentRole, 'application-context')
  assert.equal((fact.payload as any).provenance.sourceSignal, 'event_msg.item_completed.HookPrompt')
  assert.equal(output.observations.some(item => item.kind === 'message.user'), false)
})

test('Paginated Reasoning becomes visible Thinking content', async () => {
  const output = await normalizePaginatedCodexRecord(itemCompleted({
    type: 'Reasoning',
    id: 'reasoning-item-1',
    summary_text: ['先检查协议。', '再修投影。'],
    raw_content: ['private raw detail'],
  }), ctx)
  assert.ok(output)
  const fact = output.observations[0]!
  assert.equal(fact.kind, 'message.reasoning')
  assert.equal(fact.nativeEventId, 'reasoning-item-1')
  assert.equal((fact.payload as any).text, '先检查协议。\n\n再修投影。')
  assert.equal((fact.payload as any).sourceSignal, 'event_msg.item_completed.Reasoning')
  assert.equal((fact.payload as any).turnId, 'turn-1')
})

test('Paginated CommandExecution becomes one tool call/result pair', async () => {
  const output = await normalizePaginatedCodexRecord(itemCompleted({
    type: 'CommandExecution',
    id: 'command-item-1',
    command: ['npm', 'test'],
    cwd: 'file:///safe/project',
    parsed_cmd: [],
    source: 'agent',
    status: 'completed',
    stdout: 'all tests passed',
    stderr: null,
    exit_code: 0,
  }), ctx)
  assert.ok(output)
  assert.deepEqual(output.observations.map(item => item.kind), ['tool.call', 'tool.result'])
  const [call, result] = output.observations
  assert.equal(call?.nativeEventId, 'command-item-1')
  assert.equal(result?.nativeEventId, 'command-item-1')
  assert.equal((call?.payload as any).nativeToolName, 'command_execution')
  assert.equal((call?.payload as any).callId, 'command-item-1')
  assert.equal((result?.payload as any).success, true)
  assert.equal((result?.payload as any).output, 'all tests passed')
  assert.equal((result?.payload as any).turnId, 'turn-1')
})

test('Paginated FunctionCallOutput is a tool result instead of raw background activity', async () => {
  const output = await normalizePaginatedCodexRecord(itemCompleted({
    type: 'FunctionCallOutput', id: 'function-output-1', name: 'read_file',
    namespace: 'workspace', output: { text: 'file content' },
  }), ctx)
  assert.ok(output)
  const fact = output.observations[0]!
  assert.equal(fact.kind, 'tool.result')
  assert.equal(fact.nativeEventId, 'function-output-1')
  assert.equal((fact.payload as any).nativeToolName, 'read_file')
  assert.equal((fact.payload as any).namespace, 'workspace')
})

test('Paginated CollabAgentToolCall remains a visible tool operation', async () => {
  const output = await normalizePaginatedCodexRecord(itemCompleted({
    type: 'CollabAgentToolCall', id: 'collab-item-1', tool: 'spawn_agent', status: 'completed',
    sender_thread_id: 'thread-root', receiver_thread_ids: ['thread-child'],
    receiver_agents: [], prompt: '检查测试', agents_states: { 'thread-child': 'completed' },
  }), ctx)
  assert.ok(output)
  assert.deepEqual(output.observations.map(item => item.kind), ['tool.call', 'tool.result'])
  assert.equal((output.observations[0]?.payload as any).nativeToolName, 'collab_agent.spawn_agent')
  assert.equal((output.observations[1]?.payload as any).success, true)
})

test('Paginated SubAgentActivity maps native lifecycle without becoming unknown', async () => {
  const started = await normalizePaginatedCodexRecord(itemCompleted({
    type: 'SubAgentActivity', id: 'subagent-start-1', kind: 'started',
    agent_thread_id: 'thread-child', agent_path: ['worker'],
  }), ctx)
  const interacted = await normalizePaginatedCodexRecord(itemCompleted({
    type: 'SubAgentActivity', id: 'subagent-interact-1', kind: 'interacted',
    agent_thread_id: 'thread-child', agent_path: ['worker'],
  }, 2), ctx)
  const completed = await normalizePaginatedCodexRecord(itemCompleted({
    type: 'SubAgentActivity', id: 'subagent-end-1', kind: 'completed',
    agent_thread_id: 'thread-child', agent_path: ['worker'],
  }, 3), ctx)
  assert.ok(started && interacted && completed)
  assert.equal(started.observations[0]?.kind, 'subagent.spawn')
  assert.equal(interacted.observations[0]?.kind, 'session.lifecycle')
  assert.equal((interacted.observations[0]?.payload as any).event, 'subagent.interacted')
  assert.equal(completed.observations[0]?.kind, 'subagent.end')
  assert.equal(started.observations[0]?.identityHints.actorRole, 'subagent')
  assert.equal(started.observations[0]?.identityHints.nativeActorId, 'thread-child')
})

test('Paginated ReviewMode is explicit lifecycle and does not reclassify the main session', async () => {
  const entered = await normalizePaginatedCodexRecord(itemCompleted({
    type: 'EnteredReviewMode', id: 'review-entered-1',
    target: { type: 'uncommittedChanges' }, user_facing_hint: '正在审查',
  }), ctx)
  const exited = await normalizePaginatedCodexRecord(itemCompleted({
    type: 'ExitedReviewMode', id: 'review-exited-1', review_output: { findings: [] },
  }, 2), ctx)
  assert.ok(entered && exited)
  assert.equal(entered.observations[0]?.kind, 'session.lifecycle')
  assert.equal((entered.observations[0]?.payload as any).event, 'review.entered')
  assert.equal((entered.observations[0]?.payload as any).sessionActivity, undefined)
  assert.equal((exited.observations[0]?.payload as any).event, 'review.exited')
})

test('Paginated FileChange and image items are artifact actions', async () => {
  const file = await normalizePaginatedCodexRecord(itemCompleted({
    type: 'FileChange', id: 'file-change-1',
    changes: { 'src/a.ts': { type: 'update', unified_diff: '@@' } }, status: 'completed', auto_approved: true,
  }), ctx)
  const view = await normalizePaginatedCodexRecord(itemCompleted({
    type: 'ImageView', id: 'image-view-1', path: 'file:///safe/image.png',
  }, 2), ctx)
  const generated = await normalizePaginatedCodexRecord(itemCompleted({
    type: 'ImageGeneration', id: 'image-generation-1', status: 'completed',
    revised_prompt: 'a diagram', result: 'image-data', saved_path: '/safe/generated.png',
  }, 3), ctx)
  assert.ok(file && view && generated)
  assert.equal(file.observations[0]?.kind, 'artifact.action')
  assert.equal((file.observations[0]?.payload as any).action, 'file.change')
  assert.equal(view.observations[0]?.kind, 'artifact.action')
  assert.equal((view.observations[0]?.payload as any).action, 'image.view')
  assert.equal(generated.observations[0]?.kind, 'artifact.action')
  assert.equal((generated.observations[0]?.payload as any).action, 'image.generate')
})

test('extension-owned Paginated item stays raw unknown until its extension schema is known', async () => {
  const output = await normalizePaginatedCodexRecord(itemCompleted({
    type: 'Extension', id: 'extension-item-1', extension: 'future-extension', payload: { x: 1 },
  }), ctx)
  assert.ok(output)
  assert.equal(output.observations[0]?.kind, 'unknown')
})

test('Paginated item identity uses TurnItem.id instead of shared turn_id', () => {
  const first = {
    type: 'event_msg',
    payload: {
      type: 'item_completed', turn_id: 'same-turn',
      item: { type: 'AgentMessage', id: 'agent-a', content: [] },
    },
  }
  const second = {
    type: 'event_msg',
    payload: {
      type: 'item_completed', turn_id: 'same-turn',
      item: { type: 'AgentMessage', id: 'agent-b', content: [] },
    },
  }
  assert.equal(nativeIdForEntry(first), 'agent-a')
  assert.equal(nativeIdForEntry(second), 'agent-b')
  assert.notEqual(nativeIdForEntry(first), nativeIdForEntry(second))
  assert.equal(nativeTypeForEntry(first), 'event_msg/item_completed/AgentMessage')
})
