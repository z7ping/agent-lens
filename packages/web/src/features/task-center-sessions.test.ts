import assert from 'node:assert/strict'
import test from 'node:test'
import type { LiveRuntimeRefDto, ReviewSessionSummaryDto } from '@agent-lens/protocol'
import { mergeTaskCenterSessions, nativeTaskCenterSummaries, visibleTaskCenterSession } from './task-center-sessions'
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

test('实时 Pi 提供的状态项目名补齐未关联历史行',()=>{
  const linked:LiveRuntimeRefDto={...runtime,historySessionId:history.id,
    projectName:undefined,
    state:{...runtime.state,projectName:'Slowlight'},
  }
  const rows=mergeTaskCenterSessions([history], [linked])
  assert.equal(rows[0]?.item.projectName,'Slowlight')
  assert.equal(rows[0]?.item.workspacePath,'/work/Slowlight')
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

test('Native-only Catalog sessions share Task Center list without a second body index',()=>{
  const now=Date.parse('2026-10-25T15:00:00Z')
  const native={
    id:'native:0123456789abcdef0123456789abcdef',
    sourceId:'pi',installationId:'pi-local',nativeSessionId:'native-1',
    locationKind:'native' as const,
    lastActivityAt:'2026-10-25T14:00:00Z',title:'Original Source title',
    titleProvenance:'native' as const,projectId:'project-1',
    projectName:'AgentLens',workspacePath:'/work/AgentLens',
    metricsState:'complete' as const,metrics:{
      interactionCount:2,toolCallCount:0,toolResultCount:0,
      toolErrorCount:0,errorCount:0,inputTokens:null,outputTokens:null,
    },
  }
  const filters={sourceIds:null,projectId:'',status:'all' as const,
    range:'all' as const,search:''}
  const rows=nativeTaskCenterSummaries([native],filters,now)
  assert.equal(rows.length,1)
  assert.equal(rows[0]?.id,native.id)
  assert.equal(rows[0]?.title,native.title)
  assert.equal(rows[0]?.titleKind,'unverified','原生索引标题不能伪装成明确命名')
  assert.equal(rows[0]?.nativeCatalogTitle,true,'verified Source catalog titles are usable in the rail')
  assert.equal(rows[0]?.projectId,'project-1')
  assert.equal(rows[0]?.projectName,'AgentLens')
  assert.equal(rows[0]?.workspacePath,'/work/AgentLens')
  assert.equal(nativeTaskCenterSummaries([native],{...filters,projectId:'project-1'},now).length,1)
  assert.equal(nativeTaskCenterSummaries([native],{...filters,status:'clean'},now).length,1)
  assert.equal(nativeTaskCenterSummaries([{...native,
    metrics:{...native.metrics,errorCount:1}}],{...filters,status:'with-errors'},now)[0]?.hasErrors,true)
  assert.deepEqual(nativeTaskCenterSummaries([{...native,metricsState:'partial' as const}],{...filters,status:'clean'},now),[])
  assert.equal(nativeTaskCenterSummaries([{...native,titleProvenance:'generated' as const}],filters,now)[0]?.titleKind,'generated')
  assert.equal(rows[0]?.startedAt,'','never invent source creation time')
  assert.equal(rows[0]?.endedAt,native.lastActivityAt)
  assert.equal(JSON.stringify(rows).includes('installationId'),false)
  assert.equal(JSON.stringify(rows).includes('nativeSessionId'),false)
  assert.equal(mergeTaskCenterSessions(rows,[])[0]?.item.id,native.id)
  // Project/error conclusions cannot be inferred from directory metadata.
  assert.deepEqual(nativeTaskCenterSummaries([native],{...filters,projectId:'other-project'},now),[])
  assert.deepEqual(nativeTaskCenterSummaries([native],{...filters,status:'with-errors'},now),[])
  assert.deepEqual(nativeTaskCenterSummaries([native],{...filters,sourceIds:['codex']},now),[])
  assert.deepEqual(nativeTaskCenterSummaries([native],{...filters,sourceIds:[]},now),[])
  assert.deepEqual(nativeTaskCenterSummaries([native],{...filters,range:'today'},Date.parse('2026-10-26T12:00:00Z')),[])
  assert.deepEqual(nativeTaskCenterSummaries([{...native,locationKind:'archive'}],filters,now),[])
  // Legacy entry wins a same-ID ownership race; never show duplicate rows.
  assert.equal(mergeTaskCenterSessions([...rows,{...rows[0]!,title:'Legacy linked'}],[])[0]?.item.title,'Legacy linked')
})
