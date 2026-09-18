import assert from 'node:assert/strict'
import test from 'node:test'
import type { LiveRuntimeEventDto } from '@agent-lens/protocol'
import { LiveEventScheduler } from './live'

function event(
  sequence: number,
  normalizedEvent: NonNullable<LiveRuntimeEventDto['normalizedEvent']>,
): LiveRuntimeEventDto {
  return {
    runtimeSessionId: 'runtime-1',
    sequence,
    receivedAt: `2026-09-18T12:00:${String(sequence).padStart(2, '0')}.000Z`,
    event: {},
    normalizedEvent,
  }
}

test('Live event scheduler coalesces ordered text and reasoning deltas before React delivery', () => {
  const batches: LiveRuntimeEventDto[][] = []
  const scheduler = new LiveEventScheduler(events => batches.push(events))

  scheduler.push(event(1, { type: 'message.start', role: 'assistant', messageId: 'a1' }))
  scheduler.push(event(2, { type: 'text.delta', messageId: 'a1', contentIndex: 0, delta: 'hel' }))
  scheduler.push(event(3, { type: 'text.delta', messageId: 'a1', contentIndex: 0, delta: 'lo' }))
  scheduler.push(event(4, { type: 'reasoning.delta', messageId: 'a1', contentIndex: 1, delta: 'think' }))
  scheduler.push(event(5, { type: 'reasoning.delta', messageId: 'a1', contentIndex: 1, delta: 'ing' }))
  scheduler.flush()

  const delivered = batches.flat()
  assert.equal(delivered.length, 3)
  assert.equal(delivered[1]?.normalizedEvent?.type, 'text.delta')
  assert.equal(delivered[1]?.normalizedEvent?.type === 'text.delta' ? delivered[1].normalizedEvent.delta : '', 'hello')
  assert.equal(delivered[2]?.normalizedEvent?.type, 'reasoning.delta')
  assert.equal(delivered[2]?.normalizedEvent?.type === 'reasoning.delta' ? delivered[2].normalizedEvent.delta : '', 'thinking')
  assert.equal(scheduler.snapshot().ingressEvents, 5)
  assert.equal(scheduler.snapshot().coalescedEvents, 2)
  scheduler.dispose()
})

test('Live event scheduler never coalesces deltas across assistant messages', () => {
  const batches: LiveRuntimeEventDto[][] = []
  const scheduler = new LiveEventScheduler(events => batches.push(events))

  scheduler.push(event(1, { type: 'message.start', role: 'assistant', messageId: 'a1' }))
  scheduler.push(event(2, { type: 'text.delta', messageId: 'a1', contentIndex: 0, delta: 'first' }))
  scheduler.push(event(3, { type: 'message.end', role: 'assistant', messageId: 'a1' }))
  scheduler.push(event(4, { type: 'message.start', role: 'assistant', messageId: 'a2' }))
  scheduler.push(event(5, { type: 'text.delta', messageId: 'a2', contentIndex: 0, delta: 'second' }))
  scheduler.flush()

  const deltas = batches.flat().filter(value => value.normalizedEvent?.type === 'text.delta')
  assert.equal(deltas.length, 2)
  assert.deepEqual(deltas.map(value =>
    value.normalizedEvent?.type === 'text.delta' ? value.normalizedEvent.delta : ''
  ), ['first', 'second'])
  scheduler.dispose()
})

test('Live event scheduler dispose drops queued presentation work', () => {
  let delivered = 0
  const scheduler = new LiveEventScheduler(events => { delivered += events.length })
  scheduler.push(event(1, { type: 'text.delta', messageId: 'a1', contentIndex: 0, delta: 'stale' }))
  scheduler.dispose()
  scheduler.flush()
  assert.equal(delivered, 0)
})
