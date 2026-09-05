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
  return {
    id: `r-${sequence}`,
    sourceId: 'codex',
    installationId: 'install',
    sourceSessionNativeId: 'thread-root',
    nativeType: nativeTypeForEntry(entry),
    nativeId: nativeIdForEntry(entry),
    sourceSequence: sequence,
    occurredAt: '2026-09-05T08:00:00.000Z',
    capturedAt: '2026-09-05T08:00:01.000Z',
    locator: { kind: 'file', path: '/safe/paginated.jsonl', offset: sequence },
    payload: { entry, session: { nativeSessionId: 'thread-root', cwd: '/safe/project' } },
    parserVersion: '14',
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
