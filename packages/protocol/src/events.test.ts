import assert from 'node:assert/strict'
import test from 'node:test'
import { parseLiveUpdateEvent } from './events'

test('session.updated preserves logical session identity and affected areas', () => {
  assert.deepEqual(parseLiveUpdateEvent({
    type: 'session.updated',
    logicalSessionId: 'session-1',
    affected: ['review', 'sessions'],
    emittedAt: '2026-09-18T00:00:00.000Z',
  }), {
    type: 'session.updated',
    logicalSessionId: 'session-1',
    affected: ['review', 'sessions'],
    emittedAt: '2026-09-18T00:00:00.000Z',
  })
})

test('session.updated requires a logical session id', () => {
  assert.throws(() => parseLiveUpdateEvent({
    type: 'session.updated',
    affected: ['review'],
    emittedAt: '2026-09-18T00:00:00.000Z',
  }), /logicalSessionId/)
})
