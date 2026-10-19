import assert from 'node:assert/strict'
import test from 'node:test'
import type { LiveRuntimeEventDto, LiveRuntimeRefDto, LiveRuntimeStateDto } from '@agent-lens/protocol'
import { mergeTaskLiveRuntimes, parseTaskLiveRuntimeLocation, taskLiveRuntimeHref, taskLiveRuntimeStatus, shouldRecoverLiveOnVisible, shouldRefreshRuntimeListOnVisible, sameLiveRuntimeState, sameTaskRuntimeList, runtimeStateFromEvent, LIVE_VISIBILITY_RECONCILE_WINDOW_MS, LIVE_NO_PROGRESS_WARNING_MS, shouldWarnLiveNoProgress } from './task-live-runtime'

function state(overrides: Partial<LiveRuntimeStateDto> = {}): LiveRuntimeStateDto {
  return {
    runtimeSessionId: 'runtime/1',
    status: 'ready',
    isStreaming: false,
    pendingMessageCount: 0,
    ...overrides,
  }
}

test('new Live links use the generic liveId route while legacy Pi links still parse', () => {
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

  assert.equal(taskLiveRuntimeHref(pi), '/review/live/pi/runtime%2F1')
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


test('runtime list refresh replaces healthy adapters but preserves failed adapter lanes', () => {
  const previous: LiveRuntimeRefDto[] = [
    { liveId: 'pi', productId: 'pi', displayName: 'Pi', state: state({ runtimeSessionId: 'pi-old' }) },
    { liveId: 'hermes', productId: 'hermes', displayName: 'Hermes', state: state({ runtimeSessionId: 'hermes-old' }) },
  ]
  const incoming: LiveRuntimeRefDto[] = [
    { liveId: 'hermes', productId: 'hermes', displayName: 'Hermes', state: state({ runtimeSessionId: 'hermes-new' }) },
  ]

  assert.deepEqual(
    mergeTaskLiveRuntimes(previous, incoming, ['pi']).map(item => [item.liveId, item.state.runtimeSessionId]),
    [['hermes', 'hermes-new'], ['pi', 'pi-old']],
  )
  assert.deepEqual(mergeTaskLiveRuntimes(previous, [], []), [])
})

test('short tab switches stay state-only; long gaps and disconnections recover transcript', () => {
  assert.equal(shouldRecoverLiveOnVisible(0, false), false)
  assert.equal(shouldRecoverLiveOnVisible(500, false), false)
  assert.equal(shouldRecoverLiveOnVisible(LIVE_VISIBILITY_RECONCILE_WINDOW_MS - 1, false), false)
  assert.equal(shouldRecoverLiveOnVisible(LIVE_VISIBILITY_RECONCILE_WINDOW_MS, false), true)
  assert.equal(shouldRecoverLiveOnVisible(500, true), true)
})

test('runtime list resumes only when invalidated, uninitialized or stale', () => {
  const now = 100_000
  assert.equal(shouldRefreshRuntimeListOnVisible(now, now - 500, 300, false), false)
  assert.equal(shouldRefreshRuntimeListOnVisible(now, now - 500, 300, true), true)
  assert.equal(shouldRefreshRuntimeListOnVisible(now, 0, 300, false), true)
  assert.equal(shouldRefreshRuntimeListOnVisible(now, now - LIVE_VISIBILITY_RECONCILE_WINDOW_MS, 300, false), true)
  assert.equal(shouldRefreshRuntimeListOnVisible(now, now - 500, LIVE_VISIBILITY_RECONCILE_WINDOW_MS, false), true)
})

test('unchanged runtime state and list reuse React state', () => {
  const first = state({ title: 'A', workspacePath: '/workspace', nativeSessionId: 'native-a' })
  assert.equal(sameLiveRuntimeState(first, { ...first }), true)
  assert.equal(sameLiveRuntimeState(first, { ...first, pendingMessageCount: 2 }), false)
  const runtimes: LiveRuntimeRefDto[] = [{ liveId: 'pi', productId: 'pi', displayName: 'Pi', state: first }]
  assert.equal(sameTaskRuntimeList(runtimes, [{ ...runtimes[0]!, state: { ...first } }]), true)
  assert.equal(sameTaskRuntimeList(runtimes, [{ ...runtimes[0]!, state: { ...first, title: 'B' } }]), false)
  assert.equal(sameTaskRuntimeList(runtimes, []), false)
})

test('标准 Live SSE 事件只修改必要状态，并正确处理流式与结束边界', () => {
  const initial = state({ title: 'Initial', pendingMessageCount: 2 })
  const event = (normalizedEvent: LiveRuntimeEventDto['normalizedEvent']): LiveRuntimeEventDto =>
    ({ normalizedEvent } as LiveRuntimeEventDto)
  assert.equal(runtimeStateFromEvent(null, event({ type: 'title.update', title: 'New' })), null)
  const titled = runtimeStateFromEvent(initial, event({ type: 'title.update', title: 'New' }))
  assert.equal(titled?.title, 'New')
  assert.equal(runtimeStateFromEvent(titled, event({ type: 'title.update', title: 'New' })), titled)
  const running = runtimeStateFromEvent(initial, event({ type: 'status', status: 'running' }))
  assert.equal(running?.isStreaming, true)
  const idle = runtimeStateFromEvent(running, event({ type: 'status', status: 'idle' }))
  assert.equal(idle?.isStreaming, false)
  const terminal = runtimeStateFromEvent(running, event({ type: 'status', status: 'terminated' }))
  assert.equal(terminal?.status, 'terminated')
  assert.equal(terminal?.isStreaming, false)
  const completed = runtimeStateFromEvent(running, event({ type: 'completed', status: 'completed' }))
  assert.equal(completed?.pendingMessageCount, 0)
  assert.equal(completed?.isStreaming, false)
})

test('Live 只有运行中连续 60 秒没有实际进展才提示检查，不误判失败', () => {
  const started = 10_000
  assert.equal(shouldWarnLiveNoProgress(started + LIVE_NO_PROGRESS_WARNING_MS - 1, started, true), false)
  assert.equal(shouldWarnLiveNoProgress(started + LIVE_NO_PROGRESS_WARNING_MS, started, true), true)
  assert.equal(shouldWarnLiveNoProgress(started + LIVE_NO_PROGRESS_WARNING_MS + 1, started, false), false)
  assert.equal(shouldWarnLiveNoProgress(started + LIVE_NO_PROGRESS_WARNING_MS, 0, true), false)
  assert.equal(shouldWarnLiveNoProgress(started + LIVE_NO_PROGRESS_WARNING_MS, Number.NaN, true), false)
  assert.equal(shouldWarnLiveNoProgress(started + 1_000, started + 500, true), false)
})
