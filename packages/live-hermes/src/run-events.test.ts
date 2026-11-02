import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeHermesLiveEvent } from './index'
import { HermesRunTranscriptAssembler } from './run-events'

function events(...items: Record<string, unknown>[]) {
  const assembler = new HermesRunTranscriptAssembler('run-1')
  return items.flatMap(item => assembler.ingest({ run_id: 'run-1', ...item }))
    .map(raw => normalizeHermesLiveEvent(raw))
    .filter(event => event !== undefined)
}

test('Hermes Runs chunks use one stable message identity, then authoritative output replaces the partial', () => {
  const result = events(
    { event: 'message.delta', delta: 'Hel' },
    { event: 'message.delta', delta: 'lo' },
    { event: 'run.completed', output: 'Hello!' },
  )
  assert.equal(result.length, 4)
  assert.equal(result[0]?.type, 'text.delta')
  assert.equal(result[1]?.type, 'text.delta')
  assert.equal(result[2]?.type, 'text.end')
  assert.equal(result[3]?.type, 'completed')
  if (result[0]?.type !== 'text.delta' || result[1]?.type !== 'text.delta'
    || result[2]?.type !== 'text.end') throw Error('unexpected text events')
  assert.equal(result[0].messageId, result[1].messageId)
  assert.equal(result[1].messageId, result[2].messageId)
  assert.equal(result[2].text, 'Hello!')
})

test('interim narration and tool calls do not swallow the final reply', () => {
  const result = events(
    { event: 'message.delta', delta: 'Checking files' },
    { event: 'message.interim', text: 'Checking files', already_streamed: true },
    { event: 'tool.started', tool: 'terminal', tool_call_id: 'call-1' },
    { event: 'tool.completed', tool: 'terminal', tool_call_id: 'call-1', duration: 0.2 },
    { event: 'message.delta', delta: 'Done' },
    { event: 'run.completed', output: 'Done' },
  )
  assert.deepEqual(result.map(item => item?.type),
    ['text.delta', 'message.end', 'tool.start', 'tool.end', 'text.delta', 'text.end', 'completed'])
  const boundary = result[1]
  assert.deepEqual(boundary && { type: boundary.type, ...('phase' in boundary ? { phase: boundary.phase } : {}) },
    { type: 'message.end', phase: 'commentary' })
  assert.notEqual(
    result[0] && 'messageId' in result[0] ? result[0].messageId : undefined,
    result[4] && 'messageId' in result[4] ? result[4].messageId : undefined)
})

test('unstreamed interim text is emitted once as commentary, never as thinking', () => {
  const result = events(
    { event: 'message.interim', text: 'Planning to inspect', already_streamed: false },
    { event: 'tool.started', tool: 'terminal' },
    { event: 'run.completed', output: 'Report ready' },
  )
  assert.deepEqual(result.map(item => item?.type),
    ['text.end', 'message.end', 'tool.start', 'text.end', 'completed'])
  assert.equal(result[0]?.type === 'text.end' ? result[0].text : '', 'Planning to inspect')
  assert.equal(result[1]?.type === 'message.end' ? result[1].phase : '', 'commentary')
})

test('tool boundary seals previously streamed narration when Hermes omits interim', () => {
  const result = events(
    { event: 'message.delta', delta: 'Searching...' },
    { event: 'tool.started', tool: 'terminal', tool_call_id: 'c1' },
    { event: 'message.delta', delta: 'Found it' },
    { event: 'run.completed', output: 'Found it' },
  )
  assert.deepEqual(result.map(item => item?.type),
    ['text.delta', 'message.end', 'tool.start', 'text.delta', 'text.end', 'completed'])
})

test('identical interim and terminal answer reuses the existing assistant message', () => {
  const result = events(
    { event: 'message.delta', delta: 'Answer before cleanup' },
    { event: 'message.interim', text: 'Answer before cleanup', already_streamed: true },
    { event: 'tool.started', tool: 'memory' },
    { event: 'run.completed', output: 'Answer before cleanup' },
  )
  assert.deepEqual(result.map(item => item?.type),
    ['text.delta', 'message.end', 'tool.start', 'message.end', 'completed'])
  assert.equal(result[3]?.type === 'message.end' ? result[3].phase : '', 'final')
  assert.equal(
    result[0] && 'messageId' in result[0] ? result[0].messageId : '',
    result[3] && 'messageId' in result[3] ? result[3].messageId : '')
})

test('completed reasoning preview never becomes user-visible answer text', () => {
  const result = events(
    { event: 'reasoning.available', text: 'Inspect the directory' },
    { event: 'message.delta', delta: 'There are 5 files' },
    { event: 'run.completed', output: 'There are 5 files' },
  )
  assert.deepEqual(result.map(item => item?.type),
    ['text.delta', 'reasoning.end', 'text.end', 'completed'])
  assert.equal(result[1]?.type === 'reasoning.end' ? result[1].text : '', 'Inspect the directory')
})

test('legacy session-chat frames remain compatible', () => {
  const result = events(
    { event: 'message.started', message: { id: 'legacy-1', role: 'assistant' } },
    { event: 'assistant.delta', message_id: 'legacy-1', delta: 'Okay' },
    { event: 'assistant.completed', message_id: 'legacy-1', content: 'Okay.' },
  )
  assert.deepEqual(result.map(item => item?.type), ['message.start', 'text.delta', 'text.end'])
  assert.equal(result[1] && 'messageId' in result[1] ? result[1].messageId : '', 'legacy-1')
})

test('older Hermes reply preview is not rendered as thinking when final output matches', () => {
  const result = events(
    { event: 'reasoning.available', text: 'This is the answer.' },
    { event: 'message.delta', delta: 'This is the answer.' },
    { event: 'run.completed', output: 'This is the answer.' },
  )
  assert.deepEqual(result.map(item => item?.type), ['text.delta', 'text.end', 'completed'])
})

test('reasoning previews are released before tools when they differ from assistant commentary', () => {
  const result = events(
    { event: 'reasoning.available', text: 'Need to inspect files' },
    { event: 'message.delta', delta: 'Checking...' },
    { event: 'tool.started', tool: 'terminal' },
    { event: 'run.completed', output: 'Finished' },
  )
  assert.deepEqual(result.map(item => item?.type),
    ['text.delta', 'reasoning.end', 'message.end', 'tool.start', 'text.end', 'completed'])
})
