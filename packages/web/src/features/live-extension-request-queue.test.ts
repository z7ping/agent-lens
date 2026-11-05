import assert from 'node:assert/strict'
import test from 'node:test'
import type { LiveEventDto } from '@agent-lens/protocol'
import { enqueueLiveUiRequest, dismissLiveUiRequest } from './live-extension-request-queue'

type Request = Extract<LiveEventDto, { type: 'ui.request' }>

test('native extension requests remain FIFO and are deduplicated by requestId', () => {
  const first: Request = { type: 'ui.request', requestId: 'a', method: 'confirm', title: 'A' }
  const second: Request = { type: 'ui.request', requestId: 'b', method: 'select', options: ['yes'] }
  let queue = enqueueLiveUiRequest([], first)
  queue = enqueueLiveUiRequest(queue, second)
  queue = enqueueLiveUiRequest(queue, first)
  assert.deepEqual(queue.map(item => item.requestId), ['a', 'b'])
  // A later request resolving first must not discard the one being displayed.
  queue = dismissLiveUiRequest(queue, 'b')
  assert.deepEqual(queue, [first])
  queue = enqueueLiveUiRequest(queue, second)
  queue = dismissLiveUiRequest(queue, 'a')
  assert.deepEqual(queue, [second])
  queue = dismissLiveUiRequest(queue, 'unknown')
  assert.deepEqual(queue, [second])
  queue = dismissLiveUiRequest(queue, 'b')
  assert.deepEqual(queue, [])
})
