import assert from 'node:assert/strict'
import test from 'node:test'
import type { LiveRuntimeEventDto } from '@agent-lens/protocol'
import {
  appendLiveInputHistory,
  appendOptimisticLiveUserMessage,
  LIVE_TASK_ROUND_FACT_LIMIT,
  projectLiveInputHistory,
  projectLiveSnapshotEntries,
  projectLiveTaskRounds,
  liveTaskRoundEstimate,
  reduceLiveTaskEvent,
} from './live-task-projection'

function event(sequence: number, normalizedEvent: NonNullable<LiveRuntimeEventDto['normalizedEvent']>): LiveRuntimeEventDto {
  return {
    runtimeSessionId: 'runtime-1',
    sequence,
    receivedAt: `2026-09-17T12:00:0${sequence}.000Z`,
    event: {},
    normalizedEvent,
  }
}

test('snapshot projection keeps generic inline image attachments', () => {
  const items = projectLiveSnapshotEntries([
    {
      id: 'u-image',
      role: 'user',
      content: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }],
    },
  ])

  assert.equal(items.length, 1)
  const item = items[0]
  assert.ok(item?.kind === 'message')
  assert.equal(item.text, '')
  assert.equal(item.attachments?.[0]?.type, 'image')
  assert.equal(item.attachments?.[0]?.dataUrl, 'data:image/png;base64,aGVsbG8=')
})

test('snapshot projection consumes message-shaped native rows without Agent-specific branches', () => {
  assert.deepEqual(projectLiveSnapshotEntries([
    { id: 'u1', role: 'user', content: 'hello' },
    { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'world' }] },
    { event: 'runtime_status', status: 'ready' },
  ]), [
    { id: 'u1', kind: 'message', role: 'user', text: 'hello', streaming: false },
    { id: 'a1', kind: 'message', role: 'assistant', text: 'world', streaming: false },
  ])
})

test('message action targets are exposed only for persisted message entries', () => {
  const items = projectLiveSnapshotEntries([
    {
      type: 'message',
      id: 'entry-user-1',
      parentId: null,
      message: { role: 'user', content: [{ type: 'text', text: 'persisted prompt' }] },
    },
    { id: 'event-user-1', role: 'user', content: 'generic event message' },
  ])

  assert.equal(items[0]?.kind === 'message' ? items[0].entryId : undefined, 'entry-user-1')
  assert.equal(items[1]?.kind === 'message' ? items[1].entryId : undefined, undefined)
})

test('snapshot projection preserves assistant reasoning and tool history across reload', () => {
  const items = projectLiveSnapshotEntries([
    {
      type: 'message',
      id: 'assistant-1',
      timestamp: '2026-09-18T00:00:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'inspect first' },
          { type: 'text', text: 'checking' },
          { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'README.md' } },
          { type: 'text', text: 'done' },
        ],
      },
    },
    {
      type: 'message',
      id: 'result-1',
      timestamp: '2026-09-18T00:00:01.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'tool-1',
        toolName: 'read',
        isError: false,
        content: [{ type: 'text', text: 'file content' }],
      },
    },
  ])

  assert.deepEqual(items.map(item => item.kind), ['thinking', 'message', 'tool', 'message'])
  assert.equal(items[0]?.kind === 'thinking' ? items[0].text : '', 'inspect first')
  const tool = items.find(item => item.kind === 'tool')
  assert.ok(tool?.kind === 'tool')
  assert.equal(tool.name, 'read')
  assert.equal(tool.status, 'success')
  assert.equal(tool.output, 'file content')
})

test('normalized Live events drive shared message reasoning and tool projections', () => {
  let items = projectLiveSnapshotEntries([])
  items = appendOptimisticLiveUserMessage(items, 'fix it', 'user:1')
  items = reduceLiveTaskEvent(items, event(1, { type: 'text.start', messageId: 'a1', contentIndex: 0 }))
  items = reduceLiveTaskEvent(items, event(2, { type: 'text.delta', messageId: 'a1', contentIndex: 0, delta: 'working' }))
  items = reduceLiveTaskEvent(items, event(3, { type: 'reasoning.delta', contentIndex: 1, delta: 'inspect repo' }))
  items = reduceLiveTaskEvent(items, event(4, { type: 'tool.start', callId: 'tool-1', name: 'read', inputPreview: 'src/index.ts' }))
  items = reduceLiveTaskEvent(items, event(5, { type: 'tool.end', callId: 'tool-1', name: 'read', status: 'success', output: 'ok', durationMs: 12 }))
  items = reduceLiveTaskEvent(items, event(6, { type: 'text.end', messageId: 'a1', contentIndex: 0, text: 'working done' }))

  assert.deepEqual(items, [
    { id: 'user:1', kind: 'message', role: 'user', text: 'fix it', streaming: false },
    { id: 'message:a1:0', kind: 'message', role: 'assistant', text: 'working done', streaming: false, at: '2026-09-17T12:00:01.000Z' },
    { id: 'thinking:content:1', kind: 'thinking', text: 'inspect repo', streaming: true, at: '2026-09-17T12:00:03.000Z' },
    { id: 'tool:tool-1', kind: 'tool', callId: 'tool-1', name: 'read', inputPreview: 'src/index.ts', output: 'ok', status: 'success', durationMs: 12, at: '2026-09-17T12:00:04.000Z' },
  ])
})


test('Live input history comes from submitted user messages and keeps chronological duplicates', () => {
  const items = projectLiveSnapshotEntries([
    { id: 'u1', role: 'user', content: 'first' },
    { id: 'a1', role: 'assistant', content: 'reply' },
    { id: 'u2', role: 'user', content: 'second' },
    { id: 'u3', role: 'user', content: 'second' },
  ])

  assert.deepEqual(projectLiveInputHistory(items), ['first', 'second', 'second'])
  assert.deepEqual(appendLiveInputHistory(['first'], ' second '), ['first', 'second'])
  assert.deepEqual(appendLiveInputHistory(['a', 'b'], 'c', 2), ['b', 'c'])
})


test('generic Live projection restores semantic rounds from user-message boundaries', () => {
  const items = [
    { id: 'u1', kind: 'message' as const, role: 'user' as const, text: 'first task', streaming: false, at: '2026-09-17T12:00:00.000Z' },
    { id: 'a1', kind: 'message' as const, role: 'assistant' as const, text: 'done', streaming: false, at: '2026-09-17T12:00:01.000Z' },
    { id: 't1', kind: 'tool' as const, callId: 'tool-1', name: 'read', status: 'success' as const, at: '2026-09-17T12:00:02.000Z' },
    { id: 'u2', kind: 'message' as const, role: 'user' as const, text: 'second task', streaming: false, at: '2026-09-17T12:00:03.000Z' },
    { id: 'r2', kind: 'thinking' as const, text: 'working', streaming: true, at: '2026-09-17T12:00:04.000Z' },
  ]

  const rounds = projectLiveTaskRounds(items)
  assert.equal(rounds.length, 2)
  assert.equal(rounds[0]?.model.ordinal, 1)
  assert.equal(rounds[0]?.model.preview, 'first task')
  assert.equal(rounds[0]?.model.toolCount, 1)
  assert.equal(rounds[0]?.model.state, 'settled')
  assert.equal(rounds[1]?.model.ordinal, 2)
  assert.equal(rounds[1]?.model.preview, 'second task')
  assert.equal(rounds[1]?.model.state, 'running')
  assert.ok(liveTaskRoundEstimate(rounds[0]!) >= 180)
})

test('generic Live projection chunks oversized semantic rounds without splitting turn identity', () => {
  const items = [
    { id: 'u1', kind: 'message' as const, role: 'user' as const, text: 'large turn', streaming: false },
    ...Array.from({ length: LIVE_TASK_ROUND_FACT_LIMIT * 2 + 1 }, (_, index) => ({
      id: `tool-${index}`,
      kind: 'tool' as const,
      callId: `call-${index}`,
      name: 'read',
      status: 'success' as const,
    })),
  ]

  const rounds = projectLiveTaskRounds(items)
  assert.equal(rounds.length, 3)
  assert.ok(rounds.every(round => round.items.length <= LIVE_TASK_ROUND_FACT_LIMIT))
  assert.ok(rounds.every(round => round.model.semanticId === 'live-round:u1'))
  assert.notEqual(rounds[0]?.model.id, rounds[1]?.model.id)
  assert.equal(rounds[0]?.model.ordinal, 1)
  assert.equal(rounds[0]?.model.toolCount, LIVE_TASK_ROUND_FACT_LIMIT * 2 + 1)
})

test('generic Live projection preserves pre-user activity as a background round', () => {
  const rounds = projectLiveTaskRounds([
    { id: 'a0', kind: 'message', role: 'assistant', text: 'restored output', streaming: false },
    { id: 'u1', kind: 'message', role: 'user', text: 'continue', streaming: false },
  ])
  assert.equal(rounds.length, 2)
  assert.equal(rounds[0]?.model.ordinal, undefined)
  assert.equal(rounds[0]?.items[0]?.id, 'a0')
  assert.equal(rounds[1]?.model.ordinal, 1)
})
