import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { HubReviewSessionSummaryDto, ReviewNodeDto } from '@agent-lens/protocol'
import { fetchHubReviewSessions } from '../client/hub-review'
import { liveApi, type LiveProductMetadata } from '../client/live'
import { useClientSnapshot } from '../client/use-client-snapshot'
import { agentLabel } from '../components/AgentScope'
import { historyTaskPresentation } from './task-center'
import { projectReviewLiveInteraction } from './review-live-interaction'
import { taskLiveRuntimeHref } from './task-live-runtime'
import { type TaskDetailModel, type TaskRoundModel } from './task-detail-model'
import { sessionDayLabel, duration, hubSessionTime, hubSessionVisibility } from './review-session-format'
import type { ReviewDayGroup, UnifiedReviewSessionListEntry } from './review-session-format'
import { interactionStats } from './ReviewRoundPresentation'
import { captureReviewReaderPosition, restoreReviewReaderPosition, highLatencyThreshold } from './review-reader-position'
import type { ReviewReaderPosition } from './review-reader-position'
import type { AgentLensClientModel } from '../client/model'
import type { ReviewDetailFilter } from '@agent-lens/protocol'

type RoundFilter = ReviewDetailFilter

/** Review 的数据请求、阅读导航与会话行为集中在此；页面只负责视图组合。 */
export function useReviewSession(model: AgentLensClientModel, embedded: boolean) {

  const { t } = useTranslation('review')
  const snapshot = useClientSnapshot(model)
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const [inspect, setInspect] = useState<ReviewNodeDto | null>(null)
  const [roundFilter, setRoundFilter] = useState<RoundFilter>('all')
  const [roundFilterLoading, setRoundFilterLoading] = useState(false)
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

  return {
    t,
    sessionId,
    navigate,
    inspect,
    setInspect,
    roundFilter,
    roundFilterLoading,
    showAllEvents,
    liveProducts,
    historyInteractionPending,
    historyInteractionError,
    pathError,
    setPathError,
    sessionLoadSentinelRef,
    detailLoadSentinelRef,
    readerPaneRef,
    roundExpansionRef,
    review,
    agents,
    projects,
    detail,
    detailLiveInteraction,
    visibleHubSessions,
    sessionGroups,
    loadOlder,
    loadFollowing,
    select,
    selectRoundFilter,
    jumpToLatest,
    showFromStart,
    taskDetailModel,
    annotatedInteractions,
    turnRailItems,
    pageIncomplete,
    isBackward,
    isFiltered,
    atStart,
    onReaderScroll,
    emptyLabel,
    toggleEventVisibility,
    noteReaderUserIntent,
    runHistoryInteraction,
  }
}
