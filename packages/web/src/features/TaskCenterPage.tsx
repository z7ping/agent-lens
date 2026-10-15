import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import type { HubReadAvailability, HubReviewSessionSummaryDto, LaunchableProjectDto, LaunchableProjectsResponseDto, ReviewSessionSummaryDto } from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { fetchHubReviewSessions } from '../client/hub-review'
import { cachedLaunchableProjects, fetchLaunchableProjects, prefetchLaunchableProjects } from '../client/launchable-projects'
import { useClientSnapshot } from '../App'
import { agentLabel, useOrderedAgents } from '../components/AgentScope'
import { AgentLogo } from '../components/AgentLogo'
import { SidebarFilterDisclosure } from '../components/SidebarFilterDisclosure'
import { Button, IconButton, Input, Popover, SelectMenu, StatusBadge } from '../components/ui'
import { UiIcon } from '../components/UiIcon'
import { historyTaskPresentation, launchableTaskProjectOptions, sessionListTitle, sortProjectFacetsByActivity, normalizedSessionSources, sessionTimeFact } from './task-center'
import { LiveNewTaskPanel } from './LiveNewTaskPanel'
import { taskLiveRuntimeHref } from './task-live-runtime'

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

function absoluteTime(value: string, locale: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date)
}

function formatTime(value: string, t: TFunction, locale: string, nowMs: number): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return t('center.time.notAvailable')
  const now = new Date(nowMs)
  const diff = now.getTime() - date.getTime()
  if (diff < 0) return absoluteTime(value, locale)
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
  return new Intl.DateTimeFormat(locale, {
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
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
  return text
}

function availabilityString(value: HubReadAvailability): string | undefined {
  return value.state === 'value' && typeof value.value === 'string' && value.value.trim()
    ? value.value.trim()
    : undefined
}

function localTime(item: ReviewSessionSummaryDto): string {
  return sessionTimeFact(item.startedAt, item.endedAt)?.at ?? ''
}

function remoteTime(item: HubReviewSessionSummaryDto): string {
  return sessionTimeFact(availabilityString(item.startedAt), availabilityString(item.endedAt))?.at ?? ''
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
  nowMs: number,
): boolean {
  if (review.filters.sourceIds !== null || review.filters.projectId || review.filters.status !== 'all') return false
  const search = review.filters.search.trim().toLowerCase()
  if (search && !remoteTitle(item, t).toLowerCase().includes(search) && !item.origin.nodeId.toLowerCase().includes(search)) return false
  const time = remoteTime(item)
  if (review.filters.range === 'all') return true
  if (!time) return false
  const at = Date.parse(time)
  if (!Number.isFinite(at)) return false
  const now = nowMs
  if (review.filters.range === 'today') {
    const date = new Date(at)
    const today = new Date(now)
    return date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
  }
  const days = review.filters.range === '7d' ? 7 : 30
  return at >= now - days * 86_400_000
}

function HistoryTaskItem({ item, active, nowMs, onClick }: { item: ReviewSessionSummaryDto; active: boolean; nowMs: number; onClick(): void }) {
  const { t, i18n } = useTranslation('task')
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  const sourceIds = normalizedSessionSources(item.sourceIds, item.productId)
  const sourceId = sourceIds[0] ?? item.productId
  const sourceNames = sourceIds.map(id => agentLabel(id))
  const fullSourceNames = sourceNames.join(' · ')
  const compactSourceNames = sourceNames.length > 1 ? `${sourceNames[0]} +${sourceNames.length - 1}` : (sourceNames[0] ?? item.productId)
  const projectLabel = item.projectName?.trim() || item.workspacePath?.split(/[\\/]/).filter(Boolean).at(-1) || t('center.history.noProject')
  const moment = sessionTimeFact(item.startedAt, item.endedAt)
  const updatedLabel = formatTime(moment?.at ?? '', t, locale, nowMs)
  const createdLabel = absoluteTime(item.startedAt, locale)
  const recentLabel = moment ? absoluteTime(moment.at, locale) : ''
  const timeTooltip = [
    ...(createdLabel ? [t('center.time.startedAt', { time: createdLabel })] : []),
    ...(recentLabel ? [t(moment?.source === 'last-activity' ? 'center.time.lastActivityAt' : 'center.time.onlyStartedAt', { time: recentLabel })] : []),
  ].join(' · ')
  const fallback = item.projectName?.trim()
    ? t('center.history.taskSuffix', { name: item.projectName.trim() })
    : t('center.history.genericAgentTask', { agent: agentLabel(sourceId, item.productId) })
  const presentation = historyTaskPresentation(item, fallback)
  const displayTitle = sessionListTitle(presentation.title, fallback, sourceIds)
  return <button className={`session-item ${active ? 'session-item-active' : ''}`} onClick={onClick} aria-label={`${displayTitle}${presentation.activityLabel ? ` · ${presentation.activityLabel}` : ''} · ${fullSourceNames} · ${projectLabel} · ${updatedLabel}`}>
    <div className="session-item-title-row">
      <div className="session-item-title" title={displayTitle}>{displayTitle}</div>
      {presentation.activityLabel && <StatusBadge className="session-activity-badge" title={item.sessionActivity === 'internal-review' ? t('center.presentation.internalReviewHint') : presentation.activityLabel}>{presentation.activityLabel}</StatusBadge>}
    </div>
    <div className="session-item-meta">
      <AgentLogo sourceId={sourceId} size="compact"/>
      <span className="session-item-source" title={fullSourceNames}>{compactSourceNames}</span>
      <span className="session-item-project" title={item.projectName ?? item.workspacePath ?? ''}>{projectLabel}</span>
      <time dateTime={moment?.at} title={timeTooltip || undefined}>{updatedLabel}</time>
    </div>
  </button>
}

function RemoteTaskItem({ item, active, nowMs, onClick }: { item: HubReviewSessionSummaryDto; active: boolean; nowMs: number; onClick(): void }) {
  const { t, i18n } = useTranslation('task')
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  const time = remoteTime(item)
  const title = sessionListTitle(remoteTitle(item, t), t('center.remote.task'))
  const created = availabilityString(item.startedAt)
  const moment = sessionTimeFact(created, availabilityString(item.endedAt))
  const createdLabel = created ? absoluteTime(created, locale) : ''
  const recentLabel = moment ? absoluteTime(moment.at, locale) : ''
  const timeTooltip = [
    ...(createdLabel ? [t('center.time.startedAt', { time: createdLabel })] : []),
    ...(recentLabel ? [t(moment?.source === 'last-activity' ? 'center.time.lastActivityAt' : 'center.time.onlyStartedAt', { time: recentLabel })] : []),
  ].join(' · ')
  return <button className={`session-item ${active ? 'session-item-active' : ''}`} onClick={onClick}>
    <div className="session-item-title-row"><div className="session-item-title" title={title}>{title}</div></div>
    <div className="session-item-meta"><span className="hub-session-source remote">{t('center.remote.source', { node: item.origin.nodeId })}</span><time dateTime={moment?.at} title={timeTooltip || undefined}>{time ? formatTime(time, t, locale, nowMs) : t('center.remote.timeNotSynced')}</time></div>
  </button>
}

export function TaskCenterPage({ model, mode, sidebarHost }: { model: AgentLensClientModel; mode: TaskCenterMode; sidebarHost?: HTMLDivElement | null }) {
  const { t, i18n } = useTranslation('task')
  const { t: tNavigation } = useTranslation('navigation')
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  const snapshot = useClientSnapshot(model)
  const location = useLocation()
  const navigate = useNavigate()
  const [hubSessions, setHubSessions] = useState<HubReviewSessionSummaryDto[]>([])
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [launchableProjects, setLaunchableProjects] = useState<LaunchableProjectDto[]>(() => cachedLaunchableProjects()?.items ?? [])
  const [launchablePage, setLaunchablePage] = useState<LaunchableProjectsResponseDto['meta'] | null>(() => cachedLaunchableProjects()?.meta ?? null)
  const [projectSearch, setProjectSearch] = useState('')
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false)
  const advancedFiltersAnchorRef = useRef<HTMLButtonElement>(null)
  const [projectLoading, setProjectLoading] = useState(mode === 'new')
  const [projectLoadingMore, setProjectLoadingMore] = useState(false)
  const [projectDiscoveryError, setProjectDiscoveryError] = useState('')
  const projectRequestGenerationRef = useRef(0)
  const historyScrollRevisionRef = useRef(0)
  const historyScrollFrameRef = useRef<number | null>(null)
  useEffect(() => () => {
    historyScrollRevisionRef.current += 1
    if (historyScrollFrameRef.current !== null) window.cancelAnimationFrame(historyScrollFrameRef.current)
    document.querySelector<HTMLElement>('.review-reader-pane')?.style.removeProperty('overflow-anchor')
  }, [])
  const review = snapshot.review
  const agents = useOrderedAgents(snapshot.facets?.agents ?? [])
  const agentSelectionSummary = review.filters.sourceIds === null
    ? t('center.history.allAgents')
    : review.filters.sourceIds.length
      ? t('center.history.selectedAgents', { count: review.filters.sourceIds.length })
      : t('center.history.noneSelected')
  const projects = snapshot.facets?.projects ?? []

  // Display-only clock: update relative labels and Today/Yesterday boundaries
  // without fetching sessions again or forcing a tab-visibility page refresh.
  useEffect(() => {
    const refreshClock = () => { if (!document.hidden) setNowMs(Date.now()) }
    const timer = window.setInterval(refreshClock, 60_000)
    document.addEventListener('visibilitychange', refreshClock)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshClock)
    }
  }, [])

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
    // 搜索切换清空旧查询；默认首页可先展示近期成功结果，再后台刷新。
    const cached = projectSearch.trim() ? undefined : cachedLaunchableProjects()
    setLaunchableProjects(cached?.items ?? [])
    setLaunchablePage(cached?.meta ?? null)
    setProjectLoading(true)
    setProjectLoadingMore(false)
    setProjectDiscoveryError('')
    const timer = window.setTimeout(() => {
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
  const visibleHub = useMemo(() => hubSessions.filter(item => remoteVisible(item, review, t, nowMs)), [hubSessions, review, t, nowMs])
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
    const now = new Date(nowMs)
    for (const item of combined) groups.get(taskDayGroup(item.at, now))!.push(item)
    return (['today', 'yesterday', 'earlier'] as const)
      .map(key => ({ key, label: t(`center.day.${key}`), items: groups.get(key)! }))
      .filter(group => group.items.length > 0)
  }, [localSessions, visibleHub, t, nowMs])
  const preferredProjectId = new URLSearchParams(location.search).get('project') || review.detail?.projectId || review.filters.projectId || undefined

  const newTask = () => {
    const params = new URLSearchParams()
    const projectId = review.detail?.projectId || review.filters.projectId
    if (projectId) params.set('project', projectId)
    const search = params.toString()
    navigate(`/review/new${search ? `?${search}` : ''}`)
  }

  const openHistoryTask = useCallback((id: string) => {
    // Repeated A-B-A switches may reuse the same session ID before an older RAF finishes.
    // Generation identity and explicit cancellation prevent stale scroll ownership.
    const revision = ++historyScrollRevisionRef.current
    if (historyScrollFrameRef.current !== null) window.cancelAnimationFrame(historyScrollFrameRef.current)
    document.querySelector<HTMLElement>('.review-reader-pane')?.style.removeProperty('overflow-anchor')
    navigate(`/review/${encodeURIComponent(id)}`)

    let remainingFrames = 90
    let stableFrames = 0
    let previousHeight = -1
    const schedule = () => { historyScrollFrameRef.current = window.requestAnimationFrame(settle) }
    const settle = () => {
      if (historyScrollRevisionRef.current !== revision) return

      const current = model.getSnapshot().review
      const pane = document.querySelector<HTMLElement>('.review-reader-pane')
      if (current.selectedId !== id || current.detailLoading || current.detail?.id !== id || !pane) {
        remainingFrames -= 1
        if (remainingFrames > 0) schedule()
        else historyScrollFrameRef.current = null
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
        historyScrollFrameRef.current = null
        return
      }
      schedule()
    }
    schedule()
  }, [model, navigate])

  const historyCount = localSessions.length + visibleHub.length
  const projectFilterOptions = useMemo(() => [
    { value: '', label: t('center.history.allProjects') },
    ...sortProjectFacetsByActivity(projects).map(project => ({ value: project.id, label: project.name ?? project.repositoryIdentity ?? project.id, description: project.repositoryIdentity ?? undefined })),
  ], [projects, t])

  const selectedAgentIds = review.filters.sourceIds ?? []
  const selectedProject = review.filters.projectId
    ? projects.find(project => project.id === review.filters.projectId)
    : undefined
  const advancedTimeActive = review.filters.range !== '7d'
  const advancedStatusActive = review.filters.status !== 'all'
  const hasActiveFilters = review.filters.sourceIds !== null || Boolean(review.filters.projectId)
    || advancedTimeActive || advancedStatusActive
  const unsupportedRemoteFilters = review.filters.sourceIds !== null
    || Boolean(review.filters.projectId) || advancedStatusActive
  const activeTimeLabel = review.filters.range === 'today' ? t('center.day.today')
    : review.filters.range === '30d' ? t('center.history.thirtyDays')
    : t('center.history.allTime')
  const activeStatusLabel = review.filters.status === 'clean' ? t('center.history.clean') : t('center.history.withErrors')
  const clearAllFilters = () => model.setReviewFilters({ sourceIds: null, projectId: '', range: '7d', status: 'all', search: '' })
  const removeAgentFilter = (sourceId: string) => {
    const next = selectedAgentIds.filter(id => id !== sourceId)
    model.setReviewFilters({ sourceIds: next })
  }

  const taskRail = <aside className="task-center-rail" aria-label={t('center.history.railAria')}>
    <div className="task-center-rail-head">
      <div className="task-center-context-brand">
        <img className="task-center-context-brand-logo" src="/agentlens-icon.svg" alt="" aria-hidden="true"/>
        <div className="task-center-context-brand-copy"><b>AgentLens</b><span aria-hidden="true">·</span><strong className="task-center-rail-title">{tNavigation('taskCenter')}</strong></div>
      </div>
      <Button size="small" variant="primary" className="task-center-new-task-button" onPointerEnter={prefetchLaunchableProjects} onFocus={prefetchLaunchableProjects} onClick={newTask} title={t('center.history.newTask')} aria-label={t('center.history.newTask')}><UiIcon name="plus" size={14}/> {t('center.history.newTaskShort')}</Button>
    </div>

    <div className="task-center-search-panel">
      <div className="task-center-search-row">
        <div className="task-center-search-field">
          <UiIcon name="search" size={14}/>
          <Input
            className="task-center-search-input"
            placeholder={t('center.history.searchPlaceholder')}
            value={review.filters.search}
            onChange={event => model.setReviewFilters({ search: event.target.value })}
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
        <IconButton size="small" className="task-center-search-refresh" onClick={() => void model.refreshReview()} title={t('center.history.refreshTasks')} aria-label={t('center.history.refreshTasks')}><UiIcon name="refresh" size={14}/></IconButton>
      </div>
    </div>

    <div className="task-center-quick-filters" aria-label={t('center.history.filterAria')}>
      <SidebarFilterDisclosure
        summary={agentSelectionSummary}
      
        agents={agents}
        agentSelection={{ mode: 'multiple', value: review.filters.sourceIds, onChange: sourceIds => model.setReviewFilters({ sourceIds }) }}
      />
      <SelectMenu
        value={review.filters.projectId}
        onChange={projectId => model.setReviewFilters({ projectId })}
        ariaLabel={t('center.history.filterProject')}
        placeholder={t('center.history.allProjects')}
        searchable
        searchPlaceholder={t('center.history.searchProject')}
        options={projectFilterOptions}
      />
      <IconButton
        ref={advancedFiltersAnchorRef}
        size="small"
        className="task-center-advanced-filter-trigger"
        aria-label={t('center.history.filterAria')}
        title={t('center.history.filterAria')}
        aria-haspopup="dialog"
        aria-expanded={advancedFiltersOpen}
        onClick={() => setAdvancedFiltersOpen(open => !open)}
      ><UiIcon name="filter" size={14}/></IconButton>
      <Popover
        open={advancedFiltersOpen}
        anchorRef={advancedFiltersAnchorRef}
        onClose={() => setAdvancedFiltersOpen(false)}
        placement="bottom-end"
        className="task-center-advanced-filter-popover"
      >
        <div className="task-center-advanced-filter-panel">
          <div className="task-center-advanced-filter-group" role="group" aria-label={t('center.history.filterTime')}>
            <span className="task-center-advanced-filter-heading">{t('center.history.time')}</span>
            <div className="task-center-advanced-filter-options">
              {([
                { value: 'today', label: t('center.day.today') },
                { value: '7d', label: t('center.history.sevenDays') },
                { value: '30d', label: t('center.history.thirtyDays') },
                { value: 'all', label: t('center.history.allTime') },
              ] as const).map(option => <button
                key={option.value}
                type="button"
                className={`task-center-filter-option ${review.filters.range === option.value ? 'is-selected' : ''}`}
                aria-pressed={review.filters.range === option.value}
                onClick={() => model.setReviewFilters({ range: option.value })}
              >{option.label}{review.filters.range === option.value && <UiIcon name="check" size={14}/>}</button>)}
            </div>
          </div>
          <div className="task-center-advanced-filter-group" role="group" aria-label={t('center.history.filterStatus')}>
            <span className="task-center-advanced-filter-heading">{t('center.history.status')}</span>
            <div className="task-center-advanced-filter-options">
              {([
                { value: 'all', label: t('center.history.allStatus') },
                { value: 'clean', label: t('center.history.clean') },
                { value: 'with-errors', label: t('center.history.withErrors') },
              ] as const).map(option => <button
                key={option.value}
                type="button"
                className={`task-center-filter-option ${review.filters.status === option.value ? 'is-selected' : ''}`}
                aria-pressed={review.filters.status === option.value}
                onClick={() => model.setReviewFilters({ status: option.value })}
              >{option.label}{review.filters.status === option.value && <UiIcon name="check" size={14}/>}</button>)}
            </div>
          </div>
        </div>
      </Popover>
    </div>

    {hasActiveFilters && <div className="task-center-active-filters">
      <div className="task-center-active-filter-list" role="group" aria-label={t('center.history.filterAria')}>
        {review.filters.sourceIds !== null && selectedAgentIds.length === 0 && <Button size="small" className="task-center-filter-chip" onClick={() => model.setReviewFilters({ sourceIds: null })}>
          {t('center.history.noneSelected')}<UiIcon name="close" size={12}/>
        </Button>}
        {selectedAgentIds.map(sourceId => <Button key={sourceId} size="small" className="task-center-filter-chip" onClick={() => removeAgentFilter(sourceId)}>
          {agentLabel(sourceId, agents.find(agent => agent.sourceId === sourceId)?.displayName)}
          <UiIcon name="close" size={12}/>
        </Button>)}
        {review.filters.projectId && <Button size="small" className="task-center-filter-chip" title={selectedProject?.name ?? selectedProject?.repositoryIdentity ?? review.filters.projectId} onClick={() => model.setReviewFilters({ projectId: '' })}>
          {selectedProject?.name ?? selectedProject?.repositoryIdentity ?? review.filters.projectId}
          <UiIcon name="close" size={12}/>
        </Button>}
        {advancedTimeActive && <Button size="small" className="task-center-filter-chip" onClick={() => model.setReviewFilters({ range: '7d' })}>
          {t('center.history.time')} · {activeTimeLabel}
          <UiIcon name="close" size={12}/>
        </Button>}
        {advancedStatusActive && <Button size="small" className="task-center-filter-chip" onClick={() => model.setReviewFilters({ status: 'all' })}>
          {t('center.history.status')} · {activeStatusLabel}
          <UiIcon name="close" size={12}/>
        </Button>}
      </div>
      <Button size="small" className="task-center-filter-clear" onClick={clearAllFilters}>{t('center.history.clearFilters')}</Button>
    </div>}

    <div className="task-center-scroll">
      {!review.response && <div className="task-center-list-skeleton" aria-hidden="true">
        <span/><span/><span/>
      </div>}

      {historyGroups.map(group => <section className="task-center-group task-center-history-group" key={group.key}>
        <div className="task-center-group-title"><span>{group.label}</span><span>{group.items.length}{group.key === 'earlier' && review.response?.meta.hasMore ? '+' : ''}</span></div>
        {group.items.map(entry => entry.kind === 'local'
          ? <HistoryTaskItem key={`local:${entry.id}`} item={entry.local} nowMs={nowMs} active={mode === 'history' && review.selectedId === entry.id} onClick={() => openHistoryTask(entry.id)}/>
          : <RemoteTaskItem key={`remote:${entry.id}`} item={entry.remote} nowMs={nowMs} active={mode === 'hub' && location.pathname === `/review/hub/${encodeURIComponent(entry.id)}`} onClick={() => navigate(`/review/hub/${encodeURIComponent(entry.id)}`)}/>)}
      </section>)}

      {review.response && !historyCount && !review.loading && <div className="task-center-empty">{t('center.history.empty')}</div>}
      {hubSessions.length > 0 && unsupportedRemoteFilters && <div className="task-center-empty" role="status">{t('center.history.remoteFilterLimitation')}</div>}
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
            nativeDirectoryPicker={/\bElectron\/\d+/i.test(navigator.userAgent)}
            projectLoading={projectLoading || (!projectDiscoveryError && !launchableProjects.length && (projectLoadingMore || Boolean(launchablePage?.nextCursor)))}
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
