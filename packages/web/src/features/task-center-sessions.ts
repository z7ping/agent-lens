import type { LiveRuntimeRefDto, LaunchableProjectDto, NativeSessionSummaryDto } from '@agent-lens/protocol'
import type { ReviewFilters } from '../client/api'
import type { TaskSessionListSummary } from './task-center'
import { taskLiveRuntimeHref } from './task-live-runtime'
import { nativeReviewTitle } from '../client/native-review-adapter'

export interface TaskCenterSession {
  item: TaskSessionListSummary
  runtime?: LiveRuntimeRefDto | undefined
  indexed: boolean
}

export function mergeTaskCenterSessions(
  history: readonly TaskSessionListSummary[],
  runtimes: readonly LiveRuntimeRefDto[],
  selectedHref = '',
): TaskCenterSession[] {
  const rows = new Map<string, TaskCenterSession>(history.map(item => [item.id, { item, indexed: true }]))
  for (const runtime of runtimes) {
    if (runtime.state.status === 'terminated' || runtime.state.status === 'terminating') continue
    const id = runtime.historySessionId ?? `live:${runtime.liveId}:${runtime.state.runtimeSessionId}`
    const previous = rows.get(id)
    // 同一会话优先保留正在阅读的实例，其次才是执行中/就绪的实例。
    const priority = (value: LiveRuntimeRefDto) => taskLiveRuntimeHref(value) === selectedHref ? 4
      : value.state.isStreaming ? 3 : value.state.status === 'ready' ? 2 : 1
    if (previous?.runtime && priority(previous.runtime) >= priority(runtime)) continue
    const startedAt = runtime.startedAt ?? ''
    const item: TaskSessionListSummary = previous?.item ?? {
      id, productId: runtime.productId, sourceIds: runtime.sourceIds?.length ? runtime.sourceIds : [runtime.productId],
      ...(runtime.projectId ? { projectId: runtime.projectId } : {}),
      ...(runtime.projectName ? { projectName: runtime.projectName } : {}),
      ...(runtime.state.workspacePath ? { workspacePath: runtime.state.workspacePath } : {}),
      ...(runtime.state.title ? { title: runtime.state.title } : {}),
      startedAt, endedAt: runtime.lastActivityAt ?? startedAt,
      hasErrors: runtime.state.status === 'failed',
    }
    rows.set(id, { item, runtime, indexed: previous?.indexed ?? false })
  }
  return [...rows.values()]
}

export function visibleTaskCenterSession(
  row: TaskCenterSession, filters: ReviewFilters, projects: readonly LaunchableProjectDto[], nowMs: number,
): boolean {
  // 历史行已由服务端完成全文搜索和过滤，不能在浏览器降级成标题搜索。
  const { item, runtime } = row
  if (!runtime || row.indexed) return true
  if (filters.sourceIds !== null && !item.sourceIds.some(id => filters.sourceIds!.includes(id))) return false
  if (filters.projectId && item.projectId !== filters.projectId) {
    if (!projects.some(project => project.projectId === filters.projectId && project.workspacePath === item.workspacePath)) return false
  }
  if (filters.status === 'with-errors' && !item.hasErrors || filters.status === 'clean' && item.hasErrors) return false
  const search = filters.search.trim().toLowerCase()
  if (search && ![item.title, item.projectName, item.workspacePath].some(value => value?.toLowerCase().includes(search))) return false
  if (filters.range !== 'all') {
    const from = new Date(nowMs)
    if (filters.range === 'today') from.setHours(0, 0, 0, 0)
    else from.setDate(from.getDate() - (filters.range === '7d' ? 7 : 30))
    const at = Date.parse(item.endedAt || item.startedAt)
    // 无时间的旧 Adapter 元数据不编造日期，也不因此隐藏仍存活的入口。
    if (Number.isFinite(at) && at < from.getTime()) return false
  }
  return true
}

/** Native-only Catalog carries metadata, never an inferred project, first
 * message, error verdict, or a second copy of the original session body.
 * Unsupported SQL-only project/error filters must not pretend to match. */
export function nativeTaskCenterSummaries(
  entries:readonly NativeSessionSummaryDto[],filters:ReviewFilters,nowMs:number,
):TaskSessionListSummary[]{
  if(filters.status!=='all' || filters.sourceIds?.length===0)return []
  const from=filters.range==='all'?Number.NEGATIVE_INFINITY
    :filters.range==='today'
      ?new Date(new Date(nowMs).setHours(0,0,0,0)).getTime()
      :nowMs-(filters.range==='7d'?7:30)*86_400_000
  return entries.filter(entry=>{
    const when=Date.parse(entry.lastActivityAt)
    const complete = entry.metricsState === 'complete' && entry.metrics !== undefined
    return entry.locationKind==='native'
      && (!filters.projectId || entry.projectId === filters.projectId)
      && (filters.sourceIds===null || filters.sourceIds.includes(entry.sourceId))
      && (filters.status==='all' || (complete && (filters.status==='with-errors'
        ? entry.metrics!.errorCount > 0 : entry.metrics!.errorCount === 0)))
      && Number.isFinite(when) && when>=from
  }).map(entry=>({
    id:entry.id,productId:entry.sourceId,sourceIds:[entry.sourceId],
    startedAt:'',endedAt:entry.lastActivityAt,
    hasErrors:entry.metricsState==='complete' && (entry.metrics?.errorCount??0)>0,
    ...(entry.projectId ? {projectId:entry.projectId}:{}),
    ...(entry.projectName ? {projectName:entry.projectName}:{}),
    ...(entry.workspacePath ? {workspacePath:entry.workspacePath}:{}),
    ...nativeReviewTitle(entry),
  }))
}
