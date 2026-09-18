import assert from 'node:assert/strict'
import test from 'node:test'
import type { LiveRuntimeRefDto, LiveRuntimeStateDto } from '@agent-lens/protocol'
import { parseTaskLiveRuntimeLocation, taskLiveRuntimeHref, taskLiveRuntimeStatus } from './task-live-runtime'

function state(overrides: Partial<LiveRuntimeStateDto> = {}): LiveRuntimeStateDto {
  return {
    runtimeSessionId: 'runtime/1',
    status: 'ready',
    isStreaming: false,
    pendingMessageCount: 0,
    ...overrides,
  }
}

test('Pi Live keeps the compatibility task route while other Live adapters use a generic route', () => {
  const pi: LiveRuntimeRefDto = {
    liveId: 'pi',
    productId: 'pi',
    displayName: 'Pi Live',
    state: state(),
  }
  const hermes: LiveRuntimeRefDto = {
    liveId: 'hermes',
    productId: 'hermes',
    displayName: 'Hermes Live',
    state: state(),
  }

  assert.equal(taskLiveRuntimeHref(pi), '/review/live/runtime%2F1')
  assert.equal(taskLiveRuntimeHref(hermes), '/review/live/hermes/runtime%2F1')
  assert.deepEqual(parseTaskLiveRuntimeLocation('/review/live/runtime%2F1'), {
    liveId: 'pi',
    runtimeSessionId: 'runtime/1',
  })
  assert.deepEqual(parseTaskLiveRuntimeLocation('/review/live/hermes/runtime%2F1'), {
    liveId: 'hermes',
    runtimeSessionId: 'runtime/1',
  })
})

test('generic task runtime status follows shared Live state', () => {
  assert.equal(taskLiveRuntimeStatus(state({ status: 'failed' })), 'failed')
  assert.equal(taskLiveRuntimeStatus(state({ status: 'initializing' })), 'initializing')
  assert.equal(taskLiveRuntimeStatus(state({ status: 'terminating', isStreaming: true })), 'terminating')
  assert.equal(taskLiveRuntimeStatus(state({ status: 'terminated', isStreaming: true })), 'terminated')
  assert.equal(taskLiveRuntimeStatus(state({ isStreaming: true })), 'streaming')
  assert.equal(taskLiveRuntimeStatus(state()), 'idle')
})
