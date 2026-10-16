import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { HubReviewSessionSummaryDto, ReviewDetailFilter, ReviewNodeDto } from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { fetchHubReviewSessions } from '../client/hub-review'
import { liveApi, type LiveProductMetadata } from '../client/live'
import { useClientSnapshot } from '../client/use-client-snapshot'
import { AgentScope, agentLabel, sourceDot } from '../components/AgentScope'
import { LocalPathActions } from '../components/LocalPathActions'
import { VirtualRoundMount } from '../components/VirtualRoundMount'
import { Button, IconButton, Input, SelectMenu, StatusBadge, Toolbar, UiIcon } from '../components/ui'
import { historyTaskPresentation, sessionListTitle } from './task-center'
import { projectReviewLiveInteraction } from './review-live-interaction'
import { taskLiveRuntimeHref } from './task-live-runtime'
import { TaskFileChangesDisclosure } from './TaskFileChangesDisclosure'
import { TaskHeader } from './TaskHeader'
import { TaskSurface } from './TaskSurface'
import { workspaceDisplayName, type TaskDetailModel, type TaskRoundModel } from './task-detail-model'
import { formatTime, formatDateTime, sessionDayLabel, sessionRelativeTime, duration, compactTitle, hubSessionTime, hubSessionTitle, hubSessionVisibility } from './review-session-format'
import type { ReviewDayGroup, UnifiedReviewSessionListEntry } from './review-session-format'
import { Inspector } from './ReviewEvidenceInspector'
import { interactionStats, ReviewRoundAdapter } from './ReviewRoundPresentation'
import { captureReviewReaderPosition, restoreReviewReaderPosition, highLatencyThreshold } from './review-reader-position'
import type { ReviewReaderPosition } from './review-reader-position'

type RoundFilter = ReviewDetailFilter

export function ReviewPage({ model, embedded = false }: { model: AgentLensClientModel; embedded?: boolean }) {
  const { t } = useTranslation('review')
  const snapshot = useClientSnapshot(model)
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const [inspect, setInspect] = useState<ReviewNodeDto | null>(null)
  const [roundFilter, setRoundFilter] = useState<RoundFilter>('all')
  const [roundFilterLoading, setRoundFilterLoading] = useState(false)
  const [expandAllRounds, setExpandAllRounds] = useState(true)
  const [roundExpansionRevision, setRoundExpansionRevision] = useState(0)
  const [showAllEvents, setShowAllEvents] = useState(true)
  const [hubSessions, setHubSessions] = useState<HubReviewSessionSummaryDto[]>([])
  const [liveProducts, setLiveProducts] = useState<LiveProductMetadata[]>([])
  const [historyInteractionPending, setHistoryInteractionPending] = useState<'' | 'resume' | 'fork'>('')
  const [historyInteractionError, setHistoryInteractionError] = useState('')
  const [pathError, setPathError] = useState('')
  const sessionLoadSentinelRef = useRef<HTMLButtonElement>(null)
  const detailLoadSentinelRef = useRef<HTMLDivElement>(null)
  const readerPaneRef = useRef<HTMLDivElement>(null)
  const readerPositionsRef = useRef(new Map<string, ReviewReaderPosition>())
  const pendingReaderAnchorRef = useRef<{ position: ReviewReaderPosition; userRevision: number } | null>(null)
  const readerUserRevisionRef = useRef(0)
  const detailAutoLoadBaselineRef = useRef(0)
  const followingTailRef = useRef(false)
  const roundExpansionRef = useRef(new Map<string, boolean>())
  const review = snapshot.review
  const agents = snapshot.facets?.agents ?? []
  const projects = snapshot.facets?.projects ?? []
  const detail = review.detail
  const detailLiveInteraction = useMemo(() => projectReviewLiveInteraction(detail, liveProducts), [detail?.productId, liveProducts])
  const visibleHubSessions = useMemo(() => hubSessions.filter(item => hubSessionVisibility(item, review)), [hubSessions, review.filters, t])
  const sessionGroups = useMemo(() => {
    const groups = new Map<ReviewDayGroup, UnifiedReviewSessionListEntry[]>()
    const now = new Date()
    const combined: UnifiedReviewSessionListEntry[] = [
      ...(review.response?.items ?? []).map(item => ({ origin: 'local' as const, id: item.id, activityAt: item.endedAt || item.startedAt, local: item })),
      ...visibleHubSessions.map(item => ({ origin: 'remote' as const, id: item.id, activityAt: hubSessionTime(item), remote: item })),
    ].sort((left, right) => {
      const leftAt = Date.parse(left.activityAt)
      const rightAt = Date.parse(right.activityAt)
      if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt != rightAt) return rightAt - leftAt
      if (Number.isFinite(leftAt) && !Number.isFinite(rightAt)) return -1
      if (!Number.isFinite(leftAt) && Number.isFinite(rightAt)) return 1
      return left.id.localeCompare(right.id)
    })
    for (const item of combined) {
      const label = sessionDayLabel(item.activityAt, now)
      const items = groups.get(label) ?? []
      items.push(item)
      groups.set(label, items)
    }
    return [...groups.entries()].map(([key, items]) => ({
      key,
      label: t(`local.day.${key}`),
      items,
    }))
  }, [review.response?.items, visibleHubSessions, t])

  useEffect(() => {
    if (!detail?.id) {
      setLiveProducts([])
      return
    }
    let cancelled = false
    let retryTimer: number | undefined
    let initialTimer: number | undefined

    const refreshLiveProducts = (allowRetry = true) => {
      void liveApi.productMetadata(detail.productId).then(
        products => {
          if (cancelled) return
          if (retryTimer !== undefined) {
            window.clearTimeout(retryTimer)
            retryTimer = undefined
          }
          setLiveProducts(products)
        },
        () => {
          if (cancelled || !allowRetry) return
          if (retryTimer !== undefined) window.clearTimeout(retryTimer)
          retryTimer = window.setTimeout(() => {
            retryTimer = undefined
            refreshLiveProducts(false)
          }, 800)
        },
      )
    }
    const handleLiveStateChanged = () => refreshLiveProducts()
    initialTimer = window.setTimeout(() => refreshLiveProducts(), 100)
    window.addEventListener('agent-lens:live-state-changed', handleLiveStateChanged)
    return () => {
      cancelled = true
      if (initialTimer !== undefined) window.clearTimeout(initialTimer)
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
      window.removeEventListener('agent-lens:live-state-changed', handleLiveStateChanged)
    }
  }, [detail?.id])

  useEffect(() => {
    if (embedded) {
      setHubSessions([])
      return
    }
    let cancelled = false
    void fetchHubReviewSessions(200).then(
      value => { if (!cancelled) setHubSessions(value.items.filter(item => item.origin.kind === 'remote')) },
      () => { if (!cancelled) setHubSessions([]) },
    )
    return () => { cancelled = true }
  }, [embedded, review.response?.meta.generatedAt])

  useEffect(() => {
    if (!sessionId || (sessionId === review.selectedId && (review.detailLoading || review.detail?.id === sessionId || review.error))) return
    readerPositionsRef.current.delete(sessionId)
    void model.selectReviewSession(sessionId)
  }, [sessionId, review.selectedId, review.detail?.id, review.detailLoading, review.error, model])
  useEffect(() => {
    roundExpansionRef.current.clear()
    setRoundFilter('all')
    setRoundFilterLoading(false)
    setExpandAllRounds(true)
    setRoundExpansionRevision(0)
    setShowAllEvents(true)
    setInspect(null)
    setHistoryInteractionPending('')
    setHistoryInteractionError('')
    followingTailRef.current = false
    detailAutoLoadBaselineRef.current = readerUserRevisionRef.current
  }, [detail?.id])
  useEffect(() => {
    if (detail?.page.filter) setRoundFilter(detail.page.filter)
  }, [detail?.page.filter])

  useLayoutEffect(() => {
    const pending = pendingReaderAnchorRef.current
    if (!pending) return
    if (pending.userRevision !== readerUserRevisionRef.current) return
    const frame = window.requestAnimationFrame(() => {
      const pane = readerPaneRef.current
      if (!pane || pending.userRevision !== readerUserRevisionRef.current) return
      if (pendingReaderAnchorRef.current !== pending) return
      pendingReaderAnchorRef.current = null
      restoreReviewReaderPosition(pane, pending.position)
    })
    return () => window.cancelAnimationFrame(frame)
  })

  useLayoutEffect(() => {
    if (!detail || review.detailLoading || detail.page.filter !== 'all' || detail.page.direction !== 'backward') return
    const frame = window.requestAnimationFrame(() => {
      const pane = readerPaneRef.current
      if (!pane) return
      pane.scrollTop = pane.scrollHeight
      followingTailRef.current = true
      model.acknowledgeReviewNewData()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [detail?.id, detail?.page.direction, detail?.page.filter, review.detailLoading, model])

  useEffect(() => {
    const id = detail?.id
    if (!id || review.detailLoading) return
    const saved = readerPositionsRef.current.get(id)
    if (!saved || saved.scrollTop <= 0) return
    let cancelled = false
    const nextFrame = () => new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()))
    const restore = async () => {
      await nextFrame()
      for (let attempt = 0; attempt < 25 && !cancelled; attempt += 1) {
        const pane = readerPaneRef.current
        if (!pane) return
        if (restoreReviewReaderPosition(pane, saved)) return
        const current = model.getSnapshot().review
        if (!saved.interactionId || current.selectedId !== id || !current.detail?.page.hasMore || current.detail.page.direction !== 'forward' || current.detail.page.filter !== 'all') break
        await model.loadMoreReviewDetail()
        await nextFrame()
      }
      if (!cancelled && readerPaneRef.current) readerPaneRef.current.scrollTop = saved.scrollTop
    }
    void restore()
    return () => { cancelled = true }
  }, [detail?.id, review.detailLoading, model])

  useEffect(() => {
    const sentinel = sessionLoadSentinelRef.current
    if (!sentinel || !review.response?.meta.hasMore || review.loading || review.loadingMore || review.error) return
    const root = sentinel.closest('.session-scroll')
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void model.loadMoreReview()
    }, { root, rootMargin: '160px 0px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [review.response?.items.length, review.response?.meta.hasMore, review.loading, review.loadingMore, review.error, model])

  const loadOlder = useCallback(async () => {
    const pane = readerPaneRef.current
    if (!pane || review.detailLoadingMore) return
    const saved = captureReviewReaderPosition(pane)
    const userRevision = readerUserRevisionRef.current
    // 每页只消费一次用户滚动意图，避免短会话在 sentinel 持续可见时自动吞完整段历史。
    detailAutoLoadBaselineRef.current = userRevision
    await model.loadMoreReviewDetail()
    window.requestAnimationFrame(() => {
      const current = readerPaneRef.current
      if (!current || userRevision !== readerUserRevisionRef.current) return
      restoreReviewReaderPosition(current, saved)
    })
  }, [model, review.detailLoadingMore])

  const loadFollowing = useCallback(async () => {
    const pane = readerPaneRef.current
    if (!pane || review.detailLoadingMore) return
    const saved = captureReviewReaderPosition(pane)
    const userRevision = readerUserRevisionRef.current
    await model.loadMoreReviewDetail()
    window.requestAnimationFrame(() => {
      const current = readerPaneRef.current
      if (!current || userRevision !== readerUserRevisionRef.current) return
      restoreReviewReaderPosition(current, saved)
    })
  }, [model, review.detailLoadingMore])

  useEffect(() => {
    const sentinel = detailLoadSentinelRef.current
    if (
      !sentinel
      || !detail?.page.hasMore
      || detail.page.direction !== 'backward'
      || detail.page.filter !== 'all'
      || review.detailLoadingMore
      || review.error
    ) return
    const root = sentinel.closest('.review-reader-pane') as HTMLElement | null
    if (!root) return
    let pending = false
    const maybeLoadOlder = () => {
      if (pending || readerUserRevisionRef.current <= detailAutoLoadBaselineRef.current) return
      const rootBounds = root.getBoundingClientRect()
      const sentinelBounds = sentinel.getBoundingClientRect()
      if (sentinelBounds.top > rootBounds.bottom + 360 || sentinelBounds.bottom < rootBounds.top - 360) return
      pending = true
      void loadOlder().finally(() => { pending = false })
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) maybeLoadOlder()
    }, { root, rootMargin: '360px 0px' })
    observer.observe(sentinel)
    root.addEventListener('scroll', maybeLoadOlder, { passive: true })
    return () => {
      observer.disconnect()
      root.removeEventListener('scroll', maybeLoadOlder)
    }
  }, [
    detail?.id,
    detail?.page.hasMore,
    detail?.page.nextCursor,
    detail?.page.direction,
    detail?.page.filter,
    review.detailLoadingMore,
    review.error,
    loadOlder,
  ])

  useEffect(() => {
    const sentinel = detailLoadSentinelRef.current
    if (!sentinel || !detail?.page.hasMore || detail.page.direction !== 'forward' || review.detailLoadingMore || review.error) return
    const root = sentinel.closest('.review-reader-pane') as HTMLElement | null
    if (!root) return
    let pending = false
    const maybeLoadFollowing = () => {
      if (pending || readerUserRevisionRef.current <= detailAutoLoadBaselineRef.current) return
      const rootBounds = root.getBoundingClientRect()
      const sentinelBounds = sentinel.getBoundingClientRect()
      if (sentinelBounds.top > rootBounds.bottom + 800 || sentinelBounds.bottom < rootBounds.top - 800) return
      pending = true
      void loadFollowing().finally(() => { pending = false })
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) maybeLoadFollowing()
    }, { root, rootMargin: '800px 0px' })
    observer.observe(sentinel)
    root.addEventListener('scroll', maybeLoadFollowing, { passive: true })
    return () => {
      observer.disconnect()
      root.removeEventListener('scroll', maybeLoadFollowing)
    }
  }, [detail?.id, detail?.page.hasMore, detail?.page.nextCursor, detail?.page.direction, review.detailLoadingMore, review.error, loadFollowing])

  const select = (id: string) => {
    const pane = readerPaneRef.current
    if (detail?.id && pane) readerPositionsRef.current.set(detail.id, captureReviewReaderPosition(pane))
    readerPositionsRef.current.delete(id)
    void model.selectReviewSession(id)
    navigate(`/review/${encodeURIComponent(id)}`)
  }
  const scrollToBoundary = (boundary: 'top' | 'bottom') => {
    const pane = readerPaneRef.current
    if (!pane) return
    pane.style.setProperty('overflow-anchor', 'none')
    const apply = () => { pane.scrollTop = boundary === 'top' ? 0 : pane.scrollHeight }
    let remainingFrames = 30
    let stableFrames = 0
    let previousHeight = -1
    const settle = () => {
      apply()
      const height = pane.scrollHeight
      stableFrames = height === previousHeight ? stableFrames + 1 : 0
      previousHeight = height
      remainingFrames -= 1
      if (stableFrames >= 3 || remainingFrames <= 0) {
        pane.style.removeProperty('overflow-anchor')
        return
      }
      window.requestAnimationFrame(settle)
    }
    apply()
    window.requestAnimationFrame(settle)
    if (boundary === 'bottom') {
      followingTailRef.current = true
      model.acknowledgeReviewNewData()
    }
  }
  const scrollTop = () => scrollToBoundary('top')
  const scrollBottom = () => scrollToBoundary('bottom')

  const selectRoundFilter = async (filter: RoundFilter) => {
    if (!detail || roundFilterLoading) return
    const selectedId = detail.id
    pendingReaderAnchorRef.current = null
    detailAutoLoadBaselineRef.current = readerUserRevisionRef.current
    setRoundFilterLoading(true)
    try {
      if (filter === 'all') {
        await model.showReviewFromStart()
        if (model.getSnapshot().review.selectedId === selectedId) {
          setRoundFilter('all')
          scrollTop()
        }
      } else {
        await model.selectReviewDetailFilter(filter)
        if (model.getSnapshot().review.selectedId === selectedId) {
          setRoundFilter(filter)
          scrollTop()
        }
      }
    } finally {
      if (model.getSnapshot().review.selectedId === selectedId) setRoundFilterLoading(false)
    }
  }

  const jumpToLatest = async () => {
    if (!detail || roundFilterLoading) return
    const selectedId = detail.id
    pendingReaderAnchorRef.current = null
    detailAutoLoadBaselineRef.current = readerUserRevisionRef.current
    setRoundFilterLoading(true)
    try {
      await model.jumpToLatestReviewDetail()
      if (model.getSnapshot().review.selectedId === selectedId) {
        setRoundFilter('all')
        scrollBottom()
      }
    } finally {
      if (model.getSnapshot().review.selectedId === selectedId) setRoundFilterLoading(false)
    }
  }

  const showFromStart = async () => {
    if (!detail || roundFilterLoading) return
    const selectedId = detail.id
    pendingReaderAnchorRef.current = null
    detailAutoLoadBaselineRef.current = readerUserRevisionRef.current
    setRoundFilterLoading(true)
    try {
      await model.showReviewFromStart()
      if (model.getSnapshot().review.selectedId === selectedId) {
        setRoundFilter('all')
        scrollTop()
      }
    } finally {
      if (model.getSnapshot().review.selectedId === selectedId) setRoundFilterLoading(false)
    }
  }

  const threshold = useMemo(() => {
    if (!detail) return null
    if (detail.page.latencyThresholdMs !== undefined) return detail.page.latencyThresholdMs
    if (detail.page.filter === 'all' && detail.page.direction === 'forward' && !detail.page.hasMore) {
      return highLatencyThreshold(detail.interactions)
    }
    return null
  }, [detail])
  const taskDetailModel = useMemo<TaskDetailModel | null>(() => {
    if (!detail) return null
    const rounds: TaskRoundModel[] = detail.interactions.map(interaction => {
      const stats = interactionStats(interaction)
      return {
        id: interaction.id,
        ordinal: interaction.ordinal,
        label: interaction.trigger === 'background'
          ? t('local.interaction.background')
          : t('local.interaction.round', { count: interaction.ordinal }),
        state: 'settled',
        preview: stats.preview || undefined,
        toolCount: stats.toolCount,
        errorCount: stats.errorCount,
        durationMs: stats.durationMs,
        highLatency: detail.page.filter === 'latency' || (threshold !== null && stats.durationMs >= threshold),
      }
    })
    const title = historyTaskPresentation(
      detail,
      detail.projectName
        ? t('local.interaction.projectSession', { project: detail.projectName })
        : t('local.interaction.agentSession', { agent: agentLabel(detail.sourceIds[0] ?? '') }),
    ).title
    return {
      id: detail.id,
      title,
      agentLabel: detail.sourceIds.map(id => agentLabel(id)).join(' / '),
      projectLabel: detail.projectName,
      statusLabel: detail.errorCount > 0 ? t('local.interaction.errors') : undefined,
      startedAt: detail.startedAt,
      endedAt: detail.endedAt,
      workspacePath: detail.workspacePath,
      metrics: [
        { value: detail.interactionCount, label: t('local.interaction.metricRounds') },
        { value: detail.toolCount, label: t('local.interaction.metricCalls') },
        ...(detail.errorCount > 0 ? [{ value: detail.errorCount, label: t('local.interaction.metricErrors'), tone: 'danger' as const }] : []),
        { value: duration(detail.durationMs), label: t('local.interaction.metricSpan') },
      ],
      rounds,
    }
  }, [detail, threshold, t])
  const annotatedInteractions = useMemo(() => {
    if (!detail || !taskDetailModel) return []
    const byId = new Map(detail.interactions.map(interaction => [interaction.id, interaction] as const))
    return taskDetailModel.rounds.flatMap(round => {
      const interaction = byId.get(round.id)
      return interaction ? [{ interaction, round }] : []
    })
  }, [detail, taskDetailModel])
  const turnRailItems = useMemo(
    () => annotatedInteractions.map(({ round }) => ({
      id: round.id,
      semanticId: round.semanticId,
      label: round.label,
      preview: round.preview,
      error: round.errorCount > 0,
      state: round.state,
    })),
    [annotatedInteractions],
  )
  const pageIncomplete = detail?.page.hasMore ?? false
  const isBackward = detail?.page.direction === 'backward'
  const isFiltered = roundFilter !== 'all'
  const atStart = roundFilter === 'all' && !isBackward

  const onReaderScroll = () => {
    const pane = readerPaneRef.current
    if (!pane) return
    if (detail?.id) {
      const previous = readerPositionsRef.current.get(detail.id)
      readerPositionsRef.current.set(detail.id, {
        interactionId: previous?.interactionId ?? '',
        offset: previous?.offset ?? 0,
        scrollTop: pane.scrollTop,
      })
    }
    followingTailRef.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 180
  }

  useEffect(() => {
    if (
      !review.detailHasNewData
      || !followingTailRef.current
      || roundFilter !== 'all'
      || review.detailLoading
      || review.detailLoadingMore
    ) return

    let cancelled = false
    void model.refreshReviewTailIncremental().then(() => {
      if (cancelled || !followingTailRef.current) return
      window.requestAnimationFrame(() => {
        const pane = readerPaneRef.current
        if (!pane || !followingTailRef.current) return
        pane.scrollTop = pane.scrollHeight
      })
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [
    model,
    review.detailHasNewData,
    review.detail?.interactions.length,
    review.detailLoading,
    review.detailLoadingMore,
    roundFilter,
  ])

  const emptyLabel = roundFilter === 'errors'
    ? t('local.interaction.noErrors')
    : roundFilter === 'latency'
      ? t('local.interaction.noLatency')
      : t('local.interaction.noMatches')

  const toggleRoundExpansion = () => {
    const pane = readerPaneRef.current
    if (pane) pendingReaderAnchorRef.current = {
      position: captureReviewReaderPosition(pane),
      userRevision: readerUserRevisionRef.current,
    }
    setExpandAllRounds(value => !value)
    setRoundExpansionRevision(value => value + 1)
  }

  const toggleEventVisibility = () => {
    const pane = readerPaneRef.current
    if (pane) pendingReaderAnchorRef.current = {
      position: captureReviewReaderPosition(pane),
      userRevision: readerUserRevisionRef.current,
    }
    setShowAllEvents(value => !value)
  }

  const noteReaderUserIntent = () => {
    readerUserRevisionRef.current += 1
    pendingReaderAnchorRef.current = null
  }

  const runHistoryInteraction = async (action: 'resume' | 'fork') => {
    if (!detail || !detailLiveInteraction || historyInteractionPending) return
    if (action === 'resume' && !detailLiveInteraction.canResume) return
    if (action === 'fork' && !detailLiveInteraction.canFork) return
    setHistoryInteractionPending(action)
    setHistoryInteractionError('')
    try {
      const state = action === 'resume'
        ? await liveApi.resume(detailLiveInteraction.liveId, detail.id)
        : await liveApi.fork(detailLiveInteraction.liveId, detail.id)
      navigate(taskLiveRuntimeHref({ liveId: detailLiveInteraction.liveId, state }))
    } catch (reason) {
      setHistoryInteractionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setHistoryInteractionPending('')
    }
  }

  return <main className={`review-page ${embedded ? 'review-page-embedded' : ''}`}>
    {!embedded && <Toolbar className="workspace-toolbar" aria-label={t('local.filters.toolbarAria')}>
      <AgentScope agents={agents} value={review.filters.sourceIds?.[0] ?? ''} onChange={sourceId => model.setReviewFilters({ sourceIds: sourceId ? [sourceId] : [] })}/>
      <span className="toolbar-divider" />
      <SelectMenu value={review.filters.projectId} onChange={projectId => model.setReviewFilters({ projectId })} ariaLabel={t('local.filters.projectAria')} placeholder={t('local.filters.allProjects')} searchable searchPlaceholder={t('local.filters.searchProject')} options={[
        { value: '', label: t('local.filters.allProjects') },
        ...projects.map(project => ({ value: project.id, label: project.name ?? project.repositoryIdentity ?? project.id, description: project.repositoryIdentity ?? undefined })),
      ]}/>
      <SelectMenu value={review.filters.range} onChange={range => model.setReviewFilters({ range: range as typeof review.filters.range })} ariaLabel={t('local.filters.timeAria')} options={[
        { value: 'today', label: t('local.filters.today') }, { value: '7d', label: t('local.filters.sevenDays') }, { value: '30d', label: t('local.filters.thirtyDays') }, { value: 'all', label: t('local.filters.allTime') },
      ]}/>
      <SelectMenu value={review.filters.status} onChange={status => model.setReviewFilters({ status: status as typeof review.filters.status })} ariaLabel={t('local.filters.statusAria')} options={[
        { value: 'all', label: t('local.filters.allStatus') }, { value: 'clean', label: t('local.filters.clean') }, { value: 'with-errors', label: t('local.filters.withErrors') },
      ]}/>
      <Input className="filter search-filter" placeholder={t('local.filters.searchPlaceholder')} value={review.filters.search} onChange={e => model.setReviewFilters({ search: e.target.value })}/>
      <IconButton onClick={() => void model.refreshReview()} title={t('local.filters.refresh')} aria-label={t('local.filters.refresh')}><UiIcon name="refresh" size={16}/></IconButton>
    </Toolbar>}

    <div className="review-layout">
      {!embedded && <aside className="session-panel">
        <div className="session-panel-head"><div><b>{t('local.list.sessions')}</b><span>{t('local.list.ordering')}</span></div><span className="count-badge">{(review.response?.items.length ?? 0) + visibleHubSessions.length}{review.response?.meta.hasMore ? '+' : ''}</span></div>
        <div className="session-scroll">
          {review.loading && !review.response && <div className="empty-state">{t('local.list.loading')}</div>}
          {sessionGroups.map(group => <section className="session-group-block" key={group.key}>
            <div className="session-group">{group.label}</div>
            {group.items.map(entry => entry.origin === 'local' ? (() => {
              const item = entry.local
              const presentation = historyTaskPresentation(
                item,
                item.projectName
                  ? t('local.session.projectSession', { project: item.projectName })
                  : t('local.session.agentSession', { agent: agentLabel(item.sourceIds[0] ?? '', item.productId) }),
              )
              const liveInteraction = projectReviewLiveInteraction(item, liveProducts)
              return <button key={`local:${item.id}`} className={`session-item ${review.selectedId === item.id ? 'session-item-active' : ''}`} onClick={() => select(item.id)}>
                <div className="session-item-title-row"><div className="session-item-title" title={presentation.title}>{sessionListTitle(presentation.title, t('local.session.agentSession', { agent: agentLabel(item.sourceIds[0] ?? '', item.productId) }), item.sourceIds)}</div>{liveInteraction?.canResume ? <StatusBadge tone="success">{t('local.session.resumable')}</StatusBadge> : presentation.activityLabel && <StatusBadge className="session-activity-badge">{presentation.activityLabel}</StatusBadge>}</div>
                <div className="session-item-meta"><span className={`source-dot ${sourceDot(item.sourceIds[0] ?? '')}`}/><span>{agentLabel(item.sourceIds[0] ?? '', item.productId)}</span><span className="session-item-project">{item.projectName ?? item.workspacePath?.split(/[\\/]/).pop() ?? t('local.session.noProject')}</span><time title={t('local.list.recentActivity', { time: formatTime(entry.activityAt) })}>{sessionRelativeTime(entry.activityAt)}</time></div>
              </button>
            })() : (() => {
              const item = entry.remote
              const time = hubSessionTime(item)
              return <button key={`remote:${item.id}`} className="session-item" onClick={() => navigate(`/review/hub/${encodeURIComponent(item.id)}`)}>
                <div className="session-item-title-row"><div className="session-item-title" title={hubSessionTitle(item)}>{sessionListTitle(hubSessionTitle(item), t('local.session.remote'))}</div></div>
                <div className="session-item-meta"><span className="hub-session-source remote">{t('local.session.remoteSource', { node: item.origin.nodeId })}</span><time title={time || t('local.session.timeNotSynced')}>{time ? sessionRelativeTime(time) : t('local.session.timeNotSynced')}</time></div>
              </button>
            })())}
          </section>)}
          {review.response?.meta.hasMore && <button ref={sessionLoadSentinelRef} className="session-load-more" disabled={review.loadingMore} onClick={() => void model.loadMoreReview()}>{review.loadingMore ? t('local.list.loadMoreLoading') : review.error ? t('local.list.loadMoreFailed') : t('local.list.loadMoreAuto')}</button>}
          {review.response && !review.response.meta.hasMore && review.response.items.length > 0 && <div className="session-load-more" aria-live="polite">{t('local.list.allLoaded')}</div>}
          {!review.loading && !review.response?.items.length && !visibleHubSessions.length && <div className="empty-state">{t('local.list.empty')}</div>}
        </div>
      </aside>}

      <TaskSurface
        mode="review"
        className="review-session-view"
        boundaryNavigation={detail ? {
          startDisabled: roundFilterLoading || atStart,
          endDisabled: roundFilterLoading,
          onStart: showFromStart,
          onEnd: jumpToLatest,
        } : undefined}
        turnRailItems={detail ? turnRailItems : undefined}
      >
        {detail && <TaskHeader
          marker={<span className={`source-dot ${sourceDot(detail.sourceIds[0] ?? '')}`}/>}
          agent={taskDetailModel?.agentLabel ?? ''}
          context={taskDetailModel?.projectLabel ?? workspaceDisplayName(taskDetailModel?.workspacePath) ?? t('local.session.unlinkedProject')}
          showStatus={false}
          title={<span title={taskDetailModel?.title}>{compactTitle(taskDetailModel?.title, 15)}</span>}
          metrics={[]}
          viewActions={<Button role="menuitem" disabled={roundFilterLoading} onClick={toggleRoundExpansion}>{expandAllRounds ? t('local.roundNav.collapsePage') : t('local.roundNav.expandPage')}</Button>}
          readingControls={<Toolbar className="round-nav" aria-label={t('local.roundNav.aria')}>
            <div className="round-nav-filters" aria-label={t('local.roundNav.filterAria')}>
              <Button className={roundFilter === 'all' && !isBackward ? 'active' : ''} aria-pressed={roundFilter === 'all' && !isBackward} disabled={roundFilterLoading} onClick={() => void selectRoundFilter('all')}>{t('local.roundNav.all')}{roundFilter === 'all' && !isBackward && <span>{annotatedInteractions.length}{pageIncomplete ? '+' : ''}</span>}</Button>
              <Button className={roundFilter === 'errors' ? 'active' : ''} aria-pressed={roundFilter === 'errors'} disabled={roundFilterLoading} onClick={() => void selectRoundFilter('errors')}>{t('local.roundNav.errors')}{roundFilter === 'errors' && <span>{annotatedInteractions.length}{pageIncomplete ? '+' : ''}</span>}</Button>
              <Button className={roundFilter === 'latency' ? 'active' : ''} aria-pressed={roundFilter === 'latency'} title={t('local.roundNav.latencyNote')} disabled={roundFilterLoading} onClick={() => void selectRoundFilter('latency')}>{t('local.roundNav.latency')}{roundFilter === 'latency' && <span>{annotatedInteractions.length}{pageIncomplete ? '+' : ''}</span>}</Button>
            </div>
            <div className="round-nav-actions" aria-label={t('local.roundNav.actionsAria')}>
              {review.detailHasNewData && <Button className="round-nav-live" onClick={() => void jumpToLatest()}>{t('local.roundNav.newRecords')}<UiIcon name="arrow-down" size={14}/></Button>}
            </div>
            {roundFilterLoading && <span className="round-nav-status">{t('local.roundNav.querying')}</span>}
          </Toolbar>}
          infoItems={taskDetailModel ? [
            { label: t('local.header.project'), value: taskDetailModel.projectLabel ?? t('local.session.unlinkedProject') },
            ...(taskDetailModel.startedAt && Number.isFinite(Date.parse(taskDetailModel.startedAt))
              ? [{ label: t('local.header.startTime'), value: formatDateTime(taskDetailModel.startedAt) }] : []),
            ...(taskDetailModel.endedAt && Number.isFinite(Date.parse(taskDetailModel.endedAt))
              ? [{ label: t('local.header.endTime'), value: formatDateTime(taskDetailModel.endedAt) }] : []),
            { label: t('local.header.duration'), value: duration(detail.durationMs) },
            ...(taskDetailModel.workspacePath ? [{
              label: t('local.header.workspace'),
              value: <span className="local-path-value">
                <code title={taskDetailModel.workspacePath}>{taskDetailModel.workspacePath}</code>
                <LocalPathActions
                  path={taskDetailModel.workspacePath}
                  onOpen={path => {
                    setPathError('')
                    return model.openHostPath(path)
                  }}
                  onError={reason => setPathError(reason instanceof Error ? reason.message : String(reason))}
                />
              </span>,
            }] : []),
            ...taskDetailModel.metrics.filter(metric => metric.label !== t('local.interaction.metricSpan')).map(metric => ({ label: metric.label, value: metric.value, tone: metric.tone })),
          ] : []}
          actions={<>
            {historyInteractionPending && <StatusBadge tone="accent" dot role="status">{t('local.header.preparingHistory')}</StatusBadge>}
            {historyInteractionError && <StatusBadge tone="danger" title={historyInteractionError}>{t('local.header.continueFailed', { error: historyInteractionError })}</StatusBadge>}
            <button className="review-audit-toggle" aria-pressed={showAllEvents} onClick={toggleEventVisibility}>{showAllEvents ? t('local.header.viewAll') : t('local.header.viewCore')}</button>
          </>}
          continuationActions={<>
            {detailLiveInteraction?.canResume && <Button size="small" loading={historyInteractionPending === 'resume'} disabled={Boolean(historyInteractionPending)} onClick={() => void runHistoryInteraction('resume')}><UiIcon name="arrow-right" size={14}/>{t('local.header.continueSession')}</Button>}
            {detailLiveInteraction?.canFork && <Button size="small" loading={historyInteractionPending === 'fork'} disabled={Boolean(historyInteractionPending)} onClick={() => void runHistoryInteraction('fork')}><UiIcon name="plus" size={14}/>{t('local.header.forkContinue')}</Button>}
          </>}
        />}

        <div
          ref={readerPaneRef}
          className="review-reader-pane"
          data-review-session-id={detail?.id}
          onScroll={onReaderScroll}
          onWheelCapture={noteReaderUserIntent}
          onTouchStartCapture={noteReaderUserIntent}
          onPointerDownCapture={noteReaderUserIntent}
          onKeyDownCapture={noteReaderUserIntent}
        >
          {review.error && <div className="page-error">{review.error}</div>}
          {pathError && <div className="page-error" role="alert">{pathError}</div>}
          {!detail ? <div className="empty-state fill">{review.selectedId && review.detailLoading ? t('local.empty.loadingDetail') : t('local.empty.selectSession')}</div> : <div className="review-reader">
            {historyInteractionError && <div className="page-error" role="alert">{historyInteractionError}</div>}

            <TaskFileChangesDisclosure
              value={review.fileChanges}
              loading={review.fileChangesLoading}
              error={review.fileChangesError}
            />

            {review.relationships?.items.length ? <details className="session-relationship-tree">
              <summary><UiIcon className="session-relationship-tree-chevron" name="chevron-right" size={14}/><span>{t('local.relationship.sessionTree', { count: review.relationships.items.length })}</span></summary>
              <div>{review.relationships.items.map(item => <div key={item.id}>{item.fromNativeSessionId ?? item.fromSessionId} <span><UiIcon name="arrow-right" size={14}/></span> {item.toNativeSessionId ?? item.toSessionId}</div>)}</div>
            </details> : null}

            <div className="review-flow">
              {isBackward && roundFilter === 'all' && pageIncomplete && <div ref={detailLoadSentinelRef} className="detail-load-sentinel detail-load-sentinel-top" aria-live="polite">
                {review.detailLoadingMore
                  ? t('local.roundNav.loadingOlder')
                  : review.error
                    ? <button onClick={() => void loadOlder()}>{t('local.roundNav.loadFailedRetry')}</button>
                    : null}
              </div>}
              {annotatedInteractions.map((item, index) => <VirtualRoundMount
                key={item.round.id}
                eager={index < 6 || item.round.id === annotatedInteractions.at(-1)?.round.id}
                estimate={item.round.toolCount > 12 ? 420 : item.round.toolCount > 4 ? 300 : 220}
              >
                <ReviewRoundAdapter
                  sessionId={detail.id}
                  interaction={item.interaction}
                  round={item.round}
                  defaultExpanded={expandAllRounds}
                  expansionStore={roundExpansionRef.current}
                  forceExpanded={expandAllRounds}
                  forceRevision={roundExpansionRevision}
                  showAllEvents={showAllEvents}
                  onShowAllEvents={toggleEventVisibility}
                  inspect={setInspect}
                  loadAttachments={model.reviewAttachments}
                  loadProcess={model.reviewProcessDetail}
                />
              </VirtualRoundMount>)}
              {!annotatedInteractions.length && <div className="round-filter-empty">{emptyLabel}</div>}
              {!isBackward && roundFilter !== 'latest' && <div ref={detailLoadSentinelRef} className="detail-load-sentinel" aria-live="polite">
                {review.detailLoadingMore
                  ? t('local.roundNav.loadingFollowing', { scope: isFiltered ? t('local.roundNav.followingMatches') : t('local.roundNav.following') })
                  : detail.page.hasMore
                    ? review.error
                      ? <button onClick={() => void loadFollowing()}>{t('local.roundNav.loadFailedRetry')}</button>
                      : t('local.roundNav.autoLoadFollowing', { scope: isFiltered ? t('local.roundNav.followingMatches') : t('local.roundNav.following') })
                    : isFiltered
                      ? t('local.roundNav.allMatchesLoaded', { count: detail.interactions.length })
                      : t('local.roundNav.allLoaded', { count: detail.interactions.length })}
              </div>}
            </div>
          </div>}
        </div>
      </TaskSurface>
    </div>
    {inspect && <Inspector node={inspect} loadSourceRecords={model.sourceRecords} onClose={() => setInspect(null)}/>} 
  </main>
}
