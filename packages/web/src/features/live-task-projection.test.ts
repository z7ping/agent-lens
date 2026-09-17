import assert from 'node:assert/strict'
import test from 'node:test'
import type { LiveRuntimeEventDto } from '@agent-lens/protocol'
import {
  appendOptimisticLiveUserMessage,
  projectLiveSnapshotEntries,
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
