import assert from 'node:assert/strict'
import test from 'node:test'
import type { LiveRuntimeEventDto } from '@agent-lens/protocol'
import { HermesRunTranscriptAssembler } from '../../packages/live-hermes/src/run-events'
import { normalizeHermesLiveEvent } from '../../packages/live-hermes/src/index'
import { reduceLiveTaskEvent } from '../../packages/web/src/features/live-task-projection'

test('Hermes Runs SSE projects through the shared Live reducer without duplicate answers, thoughts or tools', () => {
  const assembler = new HermesRunTranscriptAssembler('integration-run-1')
  const native = [
    { event: 'reasoning.delta', delta: 'Inspecting ' },
    { event: 'reasoning.delta', delta: 'repository' },
    { event: 'message.delta', delta: 'Checking files' },
    { event: 'message.interim', text: 'Checking files', already_streamed: true },
    { event: 'tool.started', tool: 'terminal', preview: 'ls' },
    { event: 'tool.completed', tool: 'terminal', preview: 'done' },
    { event: 'message.delta', delta: 'Found ' },
    { event: 'message.delta', delta: 'two issues' },
    { event: 'run.completed', output: 'Found two issues.' },
  ]
  let projection: ReturnType<typeof reduceLiveTaskEvent> = []
  let sequence = 0
  for (const event of native) {
    for (const raw of assembler.ingest({ run_id: 'integration-run-1', ...event })) {
      const normalized = normalizeHermesLiveEvent(raw)
      if (!normalized) continue
      const envelope = {
        runtimeSessionId: 'runtime-1', sequence: ++sequence,
        receivedAt: '2026-11-03T12:00:00.000Z',
        event: raw, normalizedEvent: normalized,
      } as LiveRuntimeEventDto
      projection = reduceLiveTaskEvent(projection, envelope)
    }
  }
  const replies = projection.filter(item => item.kind === 'message' && item.role === 'assistant')
  const thought = projection.filter(item => item.kind === 'thinking')
  const tools = projection.filter(item => item.kind === 'tool')
  assert.equal(replies.length, 2)
  assert.deepEqual(replies.map(item => item.kind === 'message' ? item.text : ''),
    ['Checking files', 'Found two issues.'])
  assert.equal(replies[0]?.kind === 'message' ? replies[0].phase : '', 'commentary')
  assert.equal(thought.length, 1)
  assert.equal(thought[0]?.kind === 'thinking' ? thought[0].text : '', 'Inspecting repository')
  assert.equal(tools.length, 1)
  assert.equal(tools[0]?.kind === 'tool' ? tools[0].status : '', 'success')
  assert.ok(projection.every(item => item.kind !== 'message' || !item.streaming))
})

test('Hermes replayed reasoning preview matching the visible final reply never duplicates as thinking', () => {
  const assembler = new HermesRunTranscriptAssembler('integration-run-2')
  let projection: ReturnType<typeof reduceLiveTaskEvent> = []
  let sequence = 0
  for (const original of [
    { event: 'reasoning.available', text: 'This is the visible answer' },
    { event: 'message.delta', delta: 'This is the visible answer' },
    { event: 'run.completed', output: 'This is the visible answer' },
  ]) {
    for (const raw of assembler.ingest({ run_id: 'integration-run-2', ...original })) {
      const normalized = normalizeHermesLiveEvent(raw)
      if (normalized) projection = reduceLiveTaskEvent(projection, {
        runtimeSessionId: 'runtime-2', sequence: ++sequence,
        receivedAt: '2026-11-03T12:00:00.000Z', event: raw, normalizedEvent: normalized,
      } as LiveRuntimeEventDto)
    }
  }
  assert.equal(projection.filter(item => item.kind === 'thinking').length, 0)
  assert.equal(projection.filter(item => item.kind === 'message' && item.role === 'assistant').length, 1)
})
