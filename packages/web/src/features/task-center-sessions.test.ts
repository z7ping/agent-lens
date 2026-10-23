import assert from 'node:assert/strict'
import test from 'node:test'
import type { LiveRuntimeRefDto, ReviewSessionSummaryDto } from '@agent-lens/protocol'
import { mergeTaskCenterSessions, visibleTaskCenterSession } from './task-center-sessions'
import { taskLiveRuntimeHref, taskLiveRuntimeStatus } from './task-live-runtime'

const runtime: LiveRuntimeRefDto = {
  liveId: 'runtime-provider', productId: 'test-agent', displayName: '测试智能体',
  startedAt: '2026-10-23T02:18:43.000Z',
  state: { runtimeSessionId: 'runtime-1', title: 'Slowlight', workspacePath: '/work/Slowlight', status: 'ready', isStreaming: false, pendingMessageCount: 0 },
}
const history: ReviewSessionSummaryDto = {
  id: 'logical-1', installationId: 'installation-1', productId: 'test-agent', sourceIds: ['test-agent'],
  title: 'Slowlight', startedAt: runtime.startedAt!, endedAt: runtime.startedAt!,
  durationMs: 0, observationCount: 2, interactionCount: 1, toolCount: 0, errorCount: 0, hasErrors: false,
}

test('新建尚未入历史的空闲会话保留可返回的统一列表入口', () => {
  const rows = mergeTaskCenterSessions([], [runtime])
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.item.title, 'Slowlight')
  assert.equal(taskLiveRuntimeStatus(rows[0]!.runtime!.state), 'idle')
  assert.equal(taskLiveRuntimeHref(rows[0]!.runtime!), '/review/live/runtime-provider/runtime-1')
})

test('历史收录后按服务端身份合为一条，同名的其他会话保持独立', () => {
  const rows = mergeTaskCenterSessions([history, { ...history, id: 'same-title-other' }], [{ ...runtime, historySessionId: history.id }])
  assert.equal(rows.length, 2)
  assert.equal(rows.find(row => row.item.id === history.id)?.runtime?.state.runtimeSessionId, 'runtime-1')
  assert.equal(rows.find(row => row.item.id === 'same-title-other')?.runtime, undefined)
  const ended = mergeTaskCenterSessions([history], [{ ...runtime, historySessionId: history.id, state: { ...runtime.state, status: 'terminated' } }])
  assert.equal(ended.length, 1)
  assert.equal(ended[0]?.runtime, undefined)
})

test('统一筛选覆盖 Live 元数据，并保留服务端历史正文搜索命中', () => {
  const row = mergeTaskCenterSessions([], [runtime])[0]!
  const filters = { sourceIds: null, projectId: '', status: 'all', range: 'all', search: '' } as const
  const now = Date.parse('2026-10-23T03:00:00Z')
  assert.equal(visibleTaskCenterSession(row, { ...filters, search: 'Slowlight' }, [], now), true)
  assert.equal(visibleTaskCenterSession(row, { ...filters, sourceIds: [] }, [], now), false)
  assert.equal(visibleTaskCenterSession(row, { ...filters, status: 'with-errors' }, [], now), false)
  assert.equal(visibleTaskCenterSession(row, { ...filters, projectId: 'p1' }, [{ key: 'w1', projectId: 'p1', workspaceId: 'w1', workspacePath: '/work/Slowlight', lastSeenAt: runtime.startedAt! }], now), true)
  const indexed = mergeTaskCenterSessions([history], [{ ...runtime, historySessionId: history.id }])[0]!
  assert.equal(visibleTaskCenterSession(indexed, { ...filters, search: '只在正文出现的词' }, [], now), true)
})
