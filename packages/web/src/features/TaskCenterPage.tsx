import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import type { HubReadAvailability, HubReviewSessionSummaryDto, LaunchableProjectDto, LaunchableProjectsResponseDto, ReviewSessionSummaryDto } from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { fetchHubReviewSessions } from '../client/hub-review'
import { fetchLaunchableProjects } from '../client/launchable-projects'
import { useClientSnapshot } from '../App'
import { agentLabel, sourceDot, useOrderedAgents } from '../components/AgentScope'
import { SidebarFilterDisclosure } from '../components/SidebarFilterDisclosure'
import { Button, IconButton, Input, SelectMenu, StatusBadge, Toolbar } from '../components/ui'
import { UiIcon } from '../components/UiIcon'
import { historyTaskPresentation, launchableTaskProjectOptions, sessionListTitle } from './task-center'
import { LiveNewTaskPanel } from './LiveNewTaskPanel'
import { taskLiveRuntimeHref } from './task-live-runtime'
import { TaskLiveRuntimeList } from './TaskLiveRuntimeList'

export type TaskCenterMode = 'history' | 'live' | 'new' | 'hub'

const HubReviewPage = lazy(() => import('./HubReviewPage').then(module => ({ default: module.HubReviewPage })))
const LiveTaskPage = lazy(() => import('./LiveTaskPage').then(module => ({ default: module.LiveTaskPage })))
const ReviewPage = lazy(() => import('./ReviewPage').then(module => ({ default: module.ReviewPage })))
type TaskDayGroup = 'today' | 'yesterday' | 'earlier'
type HistoryTaskEntry =
  | { kind: 'local'; id: string; at: string; local: ReviewSessionSummaryDto }
  | { kind: 'remote'; id: string; at: string; remote: HubReviewSessionSummaryDto }

function mergeLaunchableProjects(
  current: readonly LaunchableProjectDto[],
  incoming: readonly LaunchableProjectDto[],
): LaunchableProjectDto[] {
  const byKey = new Map(current.map(item => [item.key, item]))
  for (const item of incoming) byKey.set(item.key, item)
  return [...byKey.values()].sort((left, right) => {
    const leftAt = Date.parse(left.lastSeenAt)
    const rightAt = Date.parse(right.lastSeenAt)
    if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) return rightAt - leftAt
    if (Number.isFinite(leftAt) && !Number.isFinite(rightAt)) return -1
    if (!Number.isFinite(leftAt) && Number.isFinite(rightAt)) return 1
    return left.key.localeCompare(right.key)
  })
}

function formatTime(value: string, t: TFunction, locale: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  const now = new Date()
  const diff = Math.max(0, now.getTime() - date.getTime())
  if (date.toDateString() === now.toDateString()) {
    const minutes = Math.floor(diff / 60_000)
    if (minutes < 1) return t('center.time.justNow')
    if (minutes < 60) return t('center.time.minutesAgo', { count: minutes })
    return t('center.time.hoursAgo', { count: Math.floor(diff / 3_600_000) })
  }
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) {
    return t('center.time.yesterdayAt', {
      time: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(date),
    })
  }
  return new Intl.DateTimeFormat(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function taskDayGroup(value: string, now = new Date()): TaskDayGroup {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'earlier'
  if (date.toDateString() === now.toDateString()) return 'today'
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return 'yesterday'
  return 'earlier'
}

function cleanTitle(value: string | undefined, fallback: string): string {
  const text = value?.replace(/\s+/g, ' ').trim() ?? ''
  if (!text) return fallback
  return text.length > 74 ? `${text.slice(0, 74)}…` : text
}

function availabilityString(value: HubReadAvailability): string | undefined {
  return value.state === 'value' && typeof value.value === 'string' && value.value.trim()
    ? value.value.trim()
    : undefined
}

function localTime(item: ReviewSessionSummaryDto): string {
  return item.endedAt || item.startedAt
}

function remoteTime(item: HubReviewSessionSummaryDto): string {
  return availabilityString(item.endedAt) ?? availabilityString(item.startedAt) ?? ''
}

function remoteTitle(item: HubReviewSessionSummaryDto, t: TFunction): string {
  const title = availabilityString(item.title)
  if (title) return cleanTitle(title, t('center.remote.task'))
  if (item.title.state === 'redacted') return t('center.remote.titleRedacted')
  if (item.title.state === 'omitted') return item.title.reason === 'policy' ? t('center.remote.titleNotSynced') : t('center.remote.task')
  return t('center.remote.task')
}

function remoteVisible(
  item: HubReviewSessionSummaryDto,
  review: ReturnType<AgentLensClientModel['getSnapshot']>['review'],
  t: TFunction,
): boolean {
  if (review.filters.sourceIds !== null || review.filters.projectId || review.filters.status !== 'all') return false
  const search = review.filters.search.trim().toLowerCase()
  if (search && !remoteTitle(item, t).toLowerCase().includes(search) && !item.origin.nodeId.toLowerCase().includes(search)) return false
  const time = remoteTime(item)
  if (!time || review.filters.range === 'all') return true
  const at = Date.parse(time)
  if (!Number.isFinite(at)) return false
  const now = Date.now()
  if (review.filters.range === 'today') {
    const date = new Date(at)
    const today = new Date(now)
    return date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
  }
  const days = review.filters.range === '7d' ? 7 : 30
  return at >= now - days * 86_400_000
}

function HistoryTaskItem({ item, active, onClick }: { item: ReviewSessionSummaryDto; active: boolean; onClick(): void }) {
  const { t, i18n } = useTranslation('task')
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  const sourceId = item.sourceIds[0] ?? ''
  const fallback = item.projectName
    ? t('center.history.taskSuffix', { name: item.projectName })
    : t('center.history.genericAgentTask', { agent: agentLabel(sourceId, item.productId) })
  const presentation = historyTaskPresentation(item, fallback)
  return <button className={`session-item ${active ? 'session-item-active' : ''}`} onClick={onClick}>
    <div className="session-item-title-row">
      <div className="session-item-title" title={presentation.title}>{sessionListTitle(presentation.title, fallback, item.sourceIds)}</div>
      {presentation.activityLabel && <StatusBadge className="session-activity-badge">{presentation.activityLabel}</StatusBadge>}
    </div>
    <div className="session-item-meta"><span className={`source-dot ${sourceDot(sourceId)}`}/><span>{agentLabel(sourceId, item.productId)}</span><span className="session-item-project">{item.projectName ?? item.workspacePath?.split(/[\\/]/).filter(Boolean).at(-1) ?? t('center.history.noProject')}</span><time>{formatTime(localTime(item), t, locale)}</time></div>
  </button>
}

function RemoteTaskItem({ item, active, onClick }: { item: HubReviewSessionSummaryDto; active: boolean; onClick(): void }) {
  const { t, i18n } = useTranslation('task')
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  const time = remoteTime(item)
  const title = remoteTitle(item, t)
  return <button className={`session-item ${active ? 'session-item-active' : ''}`} onClick={onClick}>
    <div className="session-item-title-row"><div className="session-item-title" title={title}>{sessionListTitle(title, t('center.remote.task'))}</div></div>
    <div className="session-item-meta"><span className="hub-session-source remote">{t('center.remote.source', { node: item.origin.nodeId })}</span><time>{time ? formatTime(time, t, locale) : t('center.remote.timeNotSynced')}</time></div>
  </button>
}

export function TaskCenterPage({ model, mode, sidebarHost }: { model: AgentLensClientModel; mode: TaskCenterMode; sidebarHost?: HTMLDivElement | null }) {
  const { t, i18n } = useTranslation('task')
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  const snapshot = useClientSnapshot(model)
  const location = useLocation()
  const navigate = useNavigate()
  const [hubSessions, setHubSessions] = useState<HubReviewSessionSummaryDto[]>([])
  const [launchableProjects, setLaunchableProjects] = useState<LaunchableProjectDto[]>([])
  const [launchablePage, setLaunchablePage] = useState<LaunchableProjectsResponseDto['meta'] | null>(null)
  const [projectSearch, setProjectSearch] = useState('')
  const [projectLoading, setProjectLoading] = useState(false)
  const [projectLoadingMore, setProjectLoadingMore] = useState(false)
  const [projectDiscoveryError, setProjectDiscoveryError] = useState('')
  const projectRequestGenerationRef = useRef(0)
  const historyScrollTargetRef = useRef('')
  const review = snapshot.review
  const [searchOpen, setSearchOpen] = useState(Boolean(review.filters.search))
  const agents = useOrderedAgents(snapshot.facets?.agents ?? [])
  const agentSelectionSummary = review.filters.sourceIds === null
    ? t('center.history.allAgents')
    : review.filters.sourceIds.length
      ? t('center.history.selectedAgents', { count: review.filters.sourceIds.length })
      : t('center.history.noneSelected')
  const projects = snapshot.facets?.projects ?? []

  useEffect(() => {
    if (mode === 'history' || review.response || review.loading) return
    const timer = window.setTimeout(() => {
      void model.ensureReview().catch(() => undefined)
    }, 750)
    return () => window.clearTimeout(timer)
  }, [mode, model, review.loading, review.response])

  useEffect(() => {
    if (!review.response) {
      setHubSessions([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void fetchHubReviewSessions(200).then(
        value => { if (!cancelled) setHubSessions(value.items.filter(item => item.origin.kind === 'remote')) },
        () => { if (!cancelled) setHubSessions([]) },
      )
    }, mode === 'history' ? 200 : 750)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [mode, review.response?.meta.generatedAt])

  useEffect(() => {
    if (mode !== 'new') return
    const generation = ++projectRequestGenerationRef.current
    const controller = new AbortController()
    // A new query owns a new result set. Keeping previous rows here makes
    // search/filter transitions look successful while actually showing stale projects.
    setLaunchableProjects([])
    setLaunchablePage(null)
    const timer = window.setTimeout(() => {
      setProjectLoading(true)
      setProjectLoadingMore(false)
      setProjectDiscoveryError('')
      void fetchLaunchableProjects({
        search: projectSearch,
        limit: 20,
        signal: controller.signal,
      }).then(
        value => {
          if (generation !== projectRequestGenerationRef.current) return
          setLaunchableProjects(value.items)
          setLaunchablePage(value.meta)
        },
        reason => {
          if (generation !== projectRequestGenerationRef.current || (reason instanceof DOMException && reason.name === 'AbortError')) return
          setProjectDiscoveryError(reason instanceof Error ? reason.message : String(reason))
          setLaunchablePage(null)
        },
      ).finally(() => {
        if (generation === projectRequestGenerationRef.current) setProjectLoading(false)
      })
    }, projectSearch.trim() ? 180 : 0)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [mode, projectSearch])

  const loadMoreProjects = useCallback(async () => {
    const cursor = launchablePage?.nextCursor
    if (mode !== 'new' || !cursor || projectLoading || projectLoadingMore) return
    const generation = projectRequestGenerationRef.current
    setProjectLoadingMore(true)
    setProjectDiscoveryError('')
    try {
      const value = await fetchLaunchableProjects({
        search: projectSearch,
        cursor,
        limit: 20,
      })
      if (generation !== projectRequestGenerationRef.current) return
      setLaunchableProjects(current => mergeLaunchableProjects(current, value.items))
      setLaunchablePage(value.meta)
    } catch (reason) {
      if (generation !== projectRequestGenerationRef.current) return
      setProjectDiscoveryError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (generation === projectRequestGenerationRef.current) setProjectLoadingMore(false)
    }
  }, [launchablePage?.nextCursor, mode, projectLoading, projectLoadingMore, projectSearch])

  useEffect(() => {
    if (mode !== 'new'
      || projectLoading
      || projectLoadingMore
      || projectDiscoveryError
      || launchableProjects.length > 0
      || !launchablePage?.nextCursor) return
    // A bounded server page may contain only stale paths. Keep advancing in
    // separate requests until the first usable project appears or pagination ends.
    void loadMoreProjects()
  }, [
    launchablePage?.nextCursor,
    launchableProjects.length,
    loadMoreProjects,
    mode,
    projectDiscoveryError,
    projectLoading,
    projectLoadingMore,
  ])

  const localSessions = review.response?.items ?? []
  const projectOptions = useMemo(() => launchableTaskProjectOptions(launchableProjects), [launchableProjects, locale])
  const visibleHub = useMemo(() => hubSessions.filter(item => remoteVisible(item, review, t)), [hubSessions, review, t])
  const historyGroups = useMemo(() => {
    const combined: HistoryTaskEntry[] = [
      ...localSessions.map(item => ({ kind: 'local' as const, id: item.id, at: localTime(item), local: item })),
      ...visibleHub.map(item => ({ kind: 'remote' as const, id: item.id, at: remoteTime(item), remote: item })),
    ].sort((left, right) => {
      const leftAt = Date.parse(left.at)
      const rightAt = Date.parse(right.at)
      if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) return rightAt - leftAt
      if (Number.isFinite(leftAt) && !Number.isFinite(rightAt)) return -1
      if (!Number.isFinite(leftAt) && Number.isFinite(rightAt)) return 1
      return left.id.localeCompare(right.id)
    })
    const groups = new Map<TaskDayGroup, HistoryTaskEntry[]>([['today', []], ['yesterday', []], ['earlier', []]])
    const now = new Date()
    for (const item of combined) groups.get(taskDayGroup(item.at, now))!.push(item)
    return (['today', 'yesterday', 'earlier'] as const)
      .map(key => ({ key, label: t(`center.day.${key}`), items: groups.get(key)! }))
      .filter(group => group.items.length > 0)
  }, [localSessions, visibleHub, t])
  const preferredProjectId = new URLSearchParams(location.search).get('project') || review.detail?.projectId || review.filters.projectId || undefined

  const newTask = () => {
    const params = new URLSearchParams()
    const projectId = review.detail?.projectId || review.filters.projectId
    if (projectId) params.set('project', projectId)
    const search = params.toString()
    navigate(`/review/new${search ? `?${search}` : ''}`)
  }

  const openHistoryTask = useCallback((id: string) => {
    historyScrollTargetRef.current = id
    navigate(`/review/${encodeURIComponent(id)}`)

    let remainingFrames = 90
    let stableFrames = 0
    let previousHeight = -1
    const settle = () => {
      if (historyScrollTargetRef.current !== id) {
        document.querySelector<HTMLElement>('.review-reader-pane')?.style.removeProperty('overflow-anchor')
        return
      }

      const current = model.getSnapshot().review
      const pane = document.querySelector<HTMLElement>('.review-reader-pane')
      if (current.selectedId !== id || current.detailLoading || current.detail?.id !== id || !pane) {
        remainingFrames -= 1
        if (remainingFrames > 0) window.requestAnimationFrame(settle)
        return
      }

      pane.style.setProperty('overflow-anchor', 'none')
      pane.scrollTop = pane.scrollHeight
      const height = pane.scrollHeight
      stableFrames = height === previousHeight ? stableFrames + 1 : 0
      previousHeight = height
      remainingFrames -= 1
      if (stableFrames >= 3 || remainingFrames <= 0) {
        pane.style.removeProperty('overflow-anchor')
        if (historyScrollTargetRef.current === id) historyScrollTargetRef.current = ''
        return
      }
      window.requestAnimationFrame(settle)
    }
    window.requestAnimationFrame(settle)
  }, [model, navigate])

  const historyCount = localSessions.length + visibleHub.length
  const projectFilterOptions = [
    { value: '', label: t('center.history.allProjects') },
    ...projects.map(project => ({ value: project.id, label: project.name ?? project.repositoryIdentity ?? project.id, description: project.repositoryIdentity ?? undefined })),
  ]

  const taskRail = <aside className="task-center-rail" aria-label={t('center.history.railAria')}>
    <div className="task-center-rail-head">
      <Button size="small" variant="primary" className="task-center-new-task-button" onClick={newTask}><UiIcon name="plus" size={14}/> {t('center.history.newTask')}</Button>
      <Toolbar className="task-center-toolbar" aria-label={t('center.history.filterAria')}>
        <IconButton
          size="small"
          className={searchOpen || review.filters.search ? 'is-active' : ''}
          onClick={() => setSearchOpen(current => !current)}
          title={searchOpen ? t('center.history.collapseSearch') : t('center.history.searchTasks')}
          aria-label={searchOpen ? t('center.history.collapseSearch') : t('center.history.searchTasks')}
          aria-pressed={searchOpen}
        ><UiIcon name="search" size={14}/></IconButton>
        <IconButton size="small" onClick={() => void model.refreshReview()} title={t('center.history.refreshTasks')} aria-label={t('center.history.refreshTasks')}><UiIcon name="refresh" size={14}/></IconButton>
      </Toolbar>
    </div>

    <SidebarFilterDisclosure className="task-center-sidebar-filter" summaryMeta={agentSelectionSummary} agents={agents} agentSelection={{ mode: 'multiple', value: review.filters.sourceIds, onChange: sourceIds => model.setReviewFilters({ sourceIds }) }}>
      <div className="workspace-insight-filter-fields" aria-label={t('center.history.filterAria')}>
        <label><span>{t('center.history.project')}</span><SelectMenu variant="field" value={review.filters.projectId} onChange={projectId => model.setReviewFilters({ projectId })} ariaLabel={t('center.history.filterProject')} placeholder={t('center.history.allProjects')} menuWidth={280} searchable searchPlaceholder={t('center.history.searchProject')} options={projectFilterOptions}/></label>
        <label><span>{t('center.history.time')}</span><SelectMenu variant="field" value={review.filters.range} onChange={range => model.setReviewFilters({ range: range as typeof review.filters.range })} ariaLabel={t('center.history.filterTime')} menuWidth={156} options={[
          { value: 'today', label: t('center.day.today') }, { value: '7d', label: t('center.history.sevenDays') }, { value: '30d', label: t('center.history.thirtyDays') }, { value: 'all', label: t('center.history.allTime') },
        ]}/></label>
        <label><span>{t('center.history.status')}</span><SelectMenu variant="field" value={review.filters.status} onChange={status => model.setReviewFilters({ status: status as typeof review.filters.status })} ariaLabel={t('center.history.filterStatus')} menuWidth={150} options={[
          { value: 'all', label: t('center.history.allStatus') }, { value: 'clean', label: t('center.history.clean') }, { value: 'with-errors', label: t('center.history.withErrors') },
        ]}/></label>
      </div>
    </SidebarFilterDisclosure>

    {searchOpen && <div className="task-center-search-panel">
      <div className="task-center-search-field">
        <UiIcon name="search" size={14}/>
        <Input
          autoFocus
          className="task-center-search-input"
          placeholder={t('center.history.searchPlaceholder')}
          value={review.filters.search}
          onChange={event => model.setReviewFilters({ search: event.target.value })}
          onKeyDown={event => { if (event.key === 'Escape') setSearchOpen(false) }}
          aria-label={t('center.history.searchTasks')}
        />
        {review.filters.search && <IconButton
          size="small"
          className="task-center-search-clear"
          onClick={() => model.setReviewFilters({ search: '' })}
          title={t('center.history.clearSearch')}
          aria-label={t('center.history.clearSearch')}
        ><UiIcon name="close" size={14}/></IconButton>}
      </div>
    </div>}

    <div className="task-center-scroll">
      <TaskLiveRuntimeList deferMs={mode === 'new' ? 500 : 150}/>

      {!review.response && <div className="task-center-list-skeleton" aria-hidden="true">
        <span/><span/><span/>
      </div>}

      {historyGroups.map(group => <section className="task-center-group task-center-history-group" key={group.key}>
        <div className="task-center-group-title"><span>{group.label}</span><span>{group.items.length}{group.key === 'earlier' && review.response?.meta.hasMore ? '+' : ''}</span></div>
        {group.items.map(entry => entry.kind === 'local'
          ? <HistoryTaskItem key={`local:${entry.id}`} item={entry.local} active={mode === 'history' && review.selectedId === entry.id} onClick={() => openHistoryTask(entry.id)}/>
          : <RemoteTaskItem key={`remote:${entry.id}`} item={entry.remote} active={mode === 'hub' && location.pathname === `/review/hub/${encodeURIComponent(entry.id)}`} onClick={() => navigate(`/review/hub/${encodeURIComponent(entry.id)}`)}/>)}
      </section>)}

      {review.response && !historyCount && !review.loading && <div className="task-center-empty">{t('center.history.empty')}</div>}
      {review.response?.meta.hasMore && <Button size="small" className="session-load-more" loading={review.loadingMore} onClick={() => void model.loadMoreReview()}>{t('center.history.loadMore')}</Button>}
    </div>
  </aside>

  return <>
    {sidebarHost ? createPortal(taskRail, sidebarHost) : null}
    <div className={`task-center-page ${mode === 'new' ? 'is-new-task' : ''}`}>
      <section className="task-center-main">
        <Suspense fallback={<div className="workspace-skeleton" role="status" aria-label={t('center.history.loadingDetail')}><span className="state-skeleton"/><span className="state-skeleton"/><span className="state-skeleton"/></div>}>
          {mode === 'history' && <ReviewPage model={model} embedded/>}
          {mode === 'live' && <LiveTaskPage embedded/>}
          {mode === 'hub' && <HubReviewPage embedded/>}
          {mode === 'new' && <LiveNewTaskPanel
            options={projectOptions}
            preferredProjectId={preferredProjectId}
            nativeDirectoryPicker={snapshot.health?.runtime?.owner === 'desktop'}
            projectLoading={projectLoading}
            projectHasMore={launchablePage?.hasMore ?? false}
            projectLoadingMore={projectLoadingMore}
            projectDiscoveryError={projectDiscoveryError}
            projectSearchActive={Boolean(projectSearch.trim())}
            onProjectSearch={setProjectSearch}
            onProjectLoadMore={() => void loadMoreProjects()}
            onStarted={(liveId, state) => navigate(taskLiveRuntimeHref({ liveId, state }))}
          />}
        </Suspense>
      </section>
    </div>
  </>
}
