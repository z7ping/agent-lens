import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { HubReviewSessionSummaryDto, LiveMessageDto, NativeSessionSummaryDto, ReviewNodeDto, NativeReviewTurnIndexResponseDto } from '@agent-lens/protocol'
import { fetchHubReviewSessions } from '../client/hub-review'
import { liveApi, LiveRequestError, type LiveProductMetadata } from '../client/live'
import { settleReaderAtLatest } from './session-reader-positioning'
import { clearLiveComposerDraft, liveComposerDraftKey } from '../components/live-composer-session-state'
import { useClientSnapshot } from '../client/use-client-snapshot'
import { agentLabel } from '../components/AgentScope'
import { historyTaskPresentation } from './task-center'
import { projectReviewLiveInteraction } from './review-live-interaction'
import { taskLiveRuntimeHref } from './task-live-runtime'
import { type TaskDetailModel, type TaskRoundModel } from './task-detail-model'
import { sessionDayLabel, duration, hubSessionTime, hubSessionVisibility } from './review-session-format'
import type { ReviewDayGroup, UnifiedReviewSessionListEntry } from './review-session-format'
import { interactionStats } from './ReviewRoundPresentation'
import { captureReviewReaderPosition, restoreReviewReaderPosition, highLatencyThreshold, shouldAutoFollowReviewTail } from './review-reader-position'
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
  const [nativeSessions, setNativeSessions] = useState<NativeSessionSummaryDto[]>([])
  const [nativeCursor, setNativeCursor] = useState<string | undefined>()
  const [nativeLoadingMore, setNativeLoadingMore] = useState(false)
  const [nativeBodySessions, setNativeBodySessions] = useState<NativeSessionSummaryDto[]>([])
  const [nativeBodyCursor, setNativeBodyCursor] = useState<string | undefined>()
  const [nativeBodyPartial, setNativeBodyPartial] = useState(false)
  const [nativeBodyLoading, setNativeBodyLoading] = useState(false)
  const [nativeBodyError, setNativeBodyError] = useState('')
  const [nativeTurnIndex, setNativeTurnIndex] = useState<NativeReviewTurnIndexResponseDto|null>(null)
  const nativeRequestKeyRef = useRef('')
  const [liveProducts, setLiveProducts] = useState<LiveProductMetadata[]>([])
  const [historyInteractionPending, setHistoryInteractionPending] = useState<'' | 'resume' | 'fork-at'>('')
  const [historyInteractionError, setHistoryInteractionError] = useState('')
  const [historyInteractionBlocked, setHistoryInteractionBlocked] = useState(false)
  const [pathError, setPathError] = useState('')
  const sessionLoadSentinelRef = useRef<HTMLButtonElement>(null)
  const detailLoadSentinelRef = useRef<HTMLDivElement>(null)
  const readerPaneRef = useRef<HTMLDivElement>(null)
  const readerPositionsRef = useRef(new Map<string, ReviewReaderPosition>())
  const entryPositionedSessionRef = useRef('')
  const pendingReaderAnchorRef = useRef<{ position: ReviewReaderPosition; userRevision: number } | null>(null)
  const readerUserRevisionRef = useRef(0)
  const nativeNavigationRevisionRef=useRef(0)
  const detailAutoLoadBaselineRef = useRef(0)
  const followingTailRef = useRef(false)
  const roundExpansionRef = useRef(new Map<string, boolean>())
  const review = snapshot.review
  const nativeOnly = snapshot.health?.storage.details?.schemaKind === 'slim-native-session-v1'
  const agents = snapshot.facets?.agents ?? []
  const projects = snapshot.facets?.projects ?? []
  const detail = review.detail
  const detailLiveInteraction = useMemo(
    () => detail?.statisticsCompleteness === 'window'
      ? undefined : projectReviewLiveInteraction(detail, liveProducts),
    [detail?.id, detail?.productId, detail?.statisticsCompleteness, liveProducts],
  )
  // Index progress is independent of text loading. One request scans only
  // bounded native Source pages; only a proven EOF exposes totalRounds.
  useEffect(() => {
    const id=detail?.statisticsCompleteness==='window'?detail.id:undefined
    setNativeTurnIndex(null)
    if(!id)return
    const controller=new AbortController()
    let timer:ReturnType<typeof setTimeout>|undefined
    let indexedFromCold=false
    const initialUserRevision=readerUserRevisionRef.current
    const initialNavigationRevision=nativeNavigationRevisionRef.current
    const update=async()=>{
      try{
        const result=await model.nativeReviewTurnIndex(id,{
          scan:true,tail:5,signal:controller.signal,
        })
        if(controller.signal.aborted)return
        setNativeTurnIndex(result)
        if(result.state!=='available')return
        if(result.coverage==='partial'){
          indexedFromCold=true
          timer=setTimeout(()=>{void update()},250)
          return
        }
        const view=model.getSnapshot().review
        const pane=readerPaneRef.current
        // Fresh cold indexes may finish after the first visible native page.
        // Jump to the newest turn only if the user has not read, scrolled or
        // navigated elsewhere. Never steal an active reader's position.
        if(indexedFromCold && result.totalTurns
          && initialUserRevision===readerUserRevisionRef.current
          && initialNavigationRevision===nativeNavigationRevisionRef.current
          && (pane?.scrollTop??0)<24
          && view.selectedId===id && view.detail?.statisticsCompleteness==='window'
          && view.detail.interactions[0]?.ordinal===1
          && (view.detail.interactions.at(-1)?.ordinal??0)<result.totalTurns){
          await model.jumpToLatestReviewDetail()
          // The model briefly clears detail while changing windows, which
          // cancels this index effect. That cancellation is expected here.
          window.requestAnimationFrame(()=>{
            if(initialNavigationRevision!==nativeNavigationRevisionRef.current
              || initialUserRevision!==readerUserRevisionRef.current
              || model.getSnapshot().review.selectedId!==id)return
            const target=readerPaneRef.current
            if(target)target.scrollTop=target.scrollHeight
          })
        }
      }catch {
        // A failed index must not disable the already readable native Review.
      }
    }
    void update()
    return ()=>{controller.abort();if(timer!==undefined)clearTimeout(timer)}
  },[detail?.id,detail?.statisticsCompleteness,model])

  const visibleHubSessions = useMemo(() => hubSessions.filter(item => hubSessionVisibility(item, review)), [hubSessions, review.filters, t])
  // Catalog-only sessions are a separate metadata stream, deduplicated in
  // SQLite BEFORE LIMIT. Never invent Review totals, error flags or project
  // membership for a source that has not been persisted.
  const nativeFilterKey = JSON.stringify(review.filters)
  const visibleNativeSessions = useMemo(() => {
    const { sourceIds, range, status, projectId } = review.filters
    const now = new Date()
    const start = range === 'all' ? Number.NEGATIVE_INFINITY
      : range === 'today'
        ? new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
        : now.getTime() - (range === '7d' ? 7 : 30) * 86_400_000
    const combined = new Map(nativeSessions.map(item => [item.id, item]))
    for (const item of nativeBodySessions) {
      // A text-search hit has no certified metric/project metadata. Keep the
      // Catalog's authoritative metadata if the same session is present.
      const catalog = combined.get(item.id)
      combined.set(item.id, catalog ? { ...item, ...catalog } : item)
    }
    return [...combined.values()].filter(item =>
      (sourceIds === null || sourceIds.includes(item.sourceId))
      && (!projectId || item.projectId === projectId)
      // Only verified counts can prove "clean". A partial positive error
      // count proves errors but zero from a partial page proves nothing.
      && (status === 'all' || (status === 'with-errors'
        ? (item.metricsState === 'complete' || item.metricsState === 'partial')
          && (item.metrics?.errorCount ?? 0) > 0
        : item.metricsState === 'complete' && item.metrics?.errorCount === 0))
      && Number.isFinite(Date.parse(item.lastActivityAt))
      && Date.parse(item.lastActivityAt) >= start)
  }, [nativeSessions, nativeBodySessions, nativeFilterKey])

  useEffect(() => {
    const filters = review.filters
    const allowed = !embedded && (!filters.projectId || nativeOnly)
      && (filters.status === 'all' || nativeOnly)
      && (filters.sourceIds === null || filters.sourceIds.length > 0)
    const filterChanged = nativeRequestKeyRef.current !== nativeFilterKey
    nativeRequestKeyRef.current = nativeFilterKey
    if (!allowed) {
      setNativeSessions([])
      setNativeCursor(undefined)
      return
    }
    const controller = new AbortController()
    // Ordinary Review/SSE refresh preserves existing rows until new metadata
    // is ready. Clear only on a genuine filter switch, so read position and
    // native selection do not flash during foreground/background refresh.
    if (filterChanged) {
      setNativeSessions([])
      setNativeCursor(undefined)
    }
    const sourceId = filters.sourceIds?.length === 1 ? filters.sourceIds[0] : undefined
    void model.nativeSessions({
      ...(sourceId ? { sourceId } : {}),
      ...(filters.projectId ? { projectId: filters.projectId } : {}),
      search: filters.search.trim(), limit: 100, signal: controller.signal,
    }).then(page => {
      if (controller.signal.aborted) return
      setNativeSessions(page.items)
      setNativeCursor(page.hasMore ? page.nextCursor : undefined)
    }, () => {
      if (controller.signal.aborted) return
      // Native Reader is an additive capability. It must not suppress the
      // existing persisted Review when catalog is temporarily unavailable.
      // A temporary Catalog outage must not blank already visible sessions.
      // New selections still fail closed on the actual Reader when clicked.
    })
    return () => controller.abort()
  }, [embedded, nativeOnly, nativeFilterKey, review.response?.meta.generatedAt, review.nativeRefreshRevision, model])

  // Search sanitized Source content on demand without ever indexing
  // message bodies in the Catalog/SQLite. Every response scans one bounded
  // native Source page, so empty results are explicitly incomplete until
  // the continuation reaches the end of the filtered Catalog.
  useEffect(() => {
    const filters=review.filters
    const text=filters.search.trim()
    const allowed=!embedded && !filters.projectId && filters.status==='all'
      && (filters.sourceIds===null || filters.sourceIds.length>0)
      && text.length>=2
    setNativeBodySessions([])
    setNativeBodyCursor(undefined)
    setNativeBodyPartial(false)
    setNativeBodyError('')
    if(!allowed){setNativeBodyLoading(false);return}
    const controller=new AbortController()
    const sourceId=filters.sourceIds?.length===1?filters.sourceIds[0]:undefined
    setNativeBodyLoading(true)
    void model.nativeBodySearch(text,{
      ...(sourceId?{sourceId}:{}),signal:controller.signal,
    }).then(page=>{
      if(controller.signal.aborted)return
      if(page.state!=='available'){
        setNativeBodyPartial(true)
        setNativeBodyError(page.reason)
        return
      }
      const sessions=new Map<string,NativeSessionSummaryDto>()
      for(const hit of page.items)sessions.set(hit.sessionId,{
        id:hit.sessionId,sourceId:hit.sourceId,
        installationId:hit.installationId,nativeSessionId:hit.nativeSessionId,
        locationKind:'native',lastActivityAt:hit.lastActivityAt,
        ...(hit.title?{title:hit.title}:{}),
      })
      setNativeBodySessions([...sessions.values()])
      setNativeBodyPartial(page.hasMore || page.pendingTail)
      setNativeBodyCursor(page.pendingTail?undefined:page.nextCursor)
    },error=>{
      if(controller.signal.aborted)return
      setNativeBodyPartial(true)
      setNativeBodyError(error instanceof Error?error.message:String(error))
    }).finally(()=>{
      if(!controller.signal.aborted)setNativeBodyLoading(false)
    })
    return ()=>controller.abort()
  },[embedded,nativeFilterKey,model])

  const loadMoreNativeSessions = useCallback(async () => {
    if ((!nativeCursor && !nativeBodyCursor) || nativeLoadingMore) return
    const requestKey=nativeRequestKeyRef.current
    setNativeLoadingMore(true)
    try {
      const selected=review.filters.sourceIds
      const sourceId=selected?.length===1?selected[0]:undefined
      if(nativeCursor){
        try{
          const page=await model.nativeSessions({
            ...(sourceId?{sourceId}:{}),
            ...(review.filters.projectId ? { projectId: review.filters.projectId } : {}),
            search:review.filters.search.trim(),
            limit:100,cursor:nativeCursor,
          })
          if(nativeRequestKeyRef.current!==requestKey)return
          setNativeSessions(current=>{
            const rows=new Map(current.map(item=>[item.id,item]))
            for(const item of page.items)rows.set(item.id,item)
            return [...rows.values()]
          })
          setNativeCursor(page.hasMore?page.nextCursor:undefined)
        }catch{
          // Keep existing Catalog results and cursor for manual retry.
        }
      }
      if(nativeBodyCursor && review.filters.search.trim().length>=2){
        try{
          const page=await model.nativeBodySearch(review.filters.search.trim(),{
            ...(sourceId?{sourceId}:{}),cursor:nativeBodyCursor,
          })
          if(nativeRequestKeyRef.current!==requestKey)return
          if(page.state!=='available'){
            setNativeBodyError(page.reason)
            setNativeBodyPartial(true)
          }else{
            setNativeBodySessions(current=>{
              const rows=new Map(current.map(item=>[item.id,item]))
              for(const hit of page.items)rows.set(hit.sessionId,{
                id:hit.sessionId,sourceId:hit.sourceId,
                installationId:hit.installationId,nativeSessionId:hit.nativeSessionId,
                locationKind:'native',lastActivityAt:hit.lastActivityAt,
                ...(hit.title?{title:hit.title}:{}),
              })
              return [...rows.values()]
            })
            setNativeBodyPartial(page.hasMore || page.pendingTail)
            setNativeBodyCursor(page.pendingTail?undefined:page.nextCursor)
            setNativeBodyError('')
          }
        }catch(error){
          setNativeBodyError(error instanceof Error?error.message:String(error))
          setNativeBodyPartial(true)
        }
      }
    }finally{setNativeLoadingMore(false)}
  },[nativeCursor,nativeBodyCursor,nativeLoadingMore,review.filters,nativeOnly,model])

  const sessionGroups = useMemo(() => {
    const groups = new Map<ReviewDayGroup, UnifiedReviewSessionListEntry[]>()
    const now = new Date()
    const combined: UnifiedReviewSessionListEntry[] = [
      ...(review.response?.items ?? []).map(item => ({ origin: 'local' as const, id: item.id, activityAt: item.endedAt || item.startedAt, local: item })),
      ...visibleNativeSessions.map(item => ({ origin: 'native' as const, id: item.id, activityAt: item.lastActivityAt, native: item })),
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
  }, [review.response?.items, visibleNativeSessions, visibleHubSessions, t])

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
    setShowAllEvents(true)
    setInspect(null)
    setHistoryInteractionPending('')
    setHistoryInteractionError('')
    setHistoryInteractionBlocked(false)
    followingTailRef.current = shouldAutoFollowReviewTail(detail)
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
    const id = detail.id
    if (entryPositionedSessionRef.current === id) return
    entryPositionedSessionRef.current = id
    const userRevision = readerUserRevisionRef.current
    followingTailRef.current = true
    model.acknowledgeReviewNewData()
    return settleReaderAtLatest(
      () => readerPaneRef.current,
      () => model.getSnapshot().review.selectedId === id
        && readerUserRevisionRef.current === userRevision,
    )
  }, [detail?.id, detail?.page.direction, detail?.page.filter, review.detailLoading, model])

  useEffect(() => {
    const id = detail?.id
    // Latest-page navigation always wins over a stale captured reader position.
    // Preserve anchors only while browsing earlier/forward paginated history.
    if (!id || review.detailLoading || detail?.page.direction === 'backward') return
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
    nativeNavigationRevisionRef.current++
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
    nativeNavigationRevisionRef.current++
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
    nativeNavigationRevisionRef.current++
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

  const onTurnRailSelect = async (item:{ordinal?:number}) => {
    if(!detail?.id || !item.ordinal || roundFilterLoading)return
    nativeNavigationRevisionRef.current++
    await model.jumpToReviewInteraction(item.ordinal)
    // TaskSurface retains the ordinal as a pending anchor and scrolls only
    // after the new virtual round shell has mounted. Do not race its anchor
    // with a separate scrollTop request.
  }

  const showFromStart = async () => {
    nativeNavigationRevisionRef.current++
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
      statusLabel: detail.statisticsCompleteness === 'window'
        ? undefined : detail.errorCount > 0 ? t('local.interaction.errors') : undefined,
      startedAt: detail.startedAt,
      endedAt: detail.endedAt,
      workspacePath: detail.workspacePath,
      metrics: detail.statisticsCompleteness === 'window' ? [] : [
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
      ...(round.ordinal ? {ordinal:round.ordinal,loaded:true} : {}),
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

  const sendReviewMessage = async (message: LiveMessageDto) => {
    if (!detail || !detailLiveInteraction?.canResume || !detailLiveInteraction.canSend || historyInteractionPending || historyInteractionBlocked) return
    const liveId = detailLiveInteraction.liveId
    const historicalId = detail.id
    setHistoryInteractionPending('resume')
    setHistoryInteractionError('')
    try {
      const state = await liveApi.resume(liveId, historicalId)
      await liveApi.send(liveId, state.runtimeSessionId, message)
      clearLiveComposerDraft(liveComposerDraftKey(liveId, `history:${historicalId}`))
      navigate(taskLiveRuntimeHref({ liveId, state }))
    } catch (reason) {
      // A competing Desktop writer cannot be safely resumed by our independent
      // App Server. Keep the native Review live and preserve the user's draft.
      if (reason instanceof LiveRequestError && reason.reasonCode === 'codex_thread_active_writer') {
        setHistoryInteractionBlocked(true)
      }
      setHistoryInteractionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setHistoryInteractionPending('')
    }
  }

  const retryHistoryInteraction = () => {
    // Explicit re-try only: never resend the saved draft automatically.
    setHistoryInteractionBlocked(false)
    setHistoryInteractionError('')
  }

  const forkReviewAt = async (nativeEventId: string) => {
    if (!detail || !detailLiveInteraction?.canForkAt || historyInteractionPending || !nativeEventId) return
    const liveId = detailLiveInteraction.liveId
    setHistoryInteractionPending('fork-at')
    setHistoryInteractionError('')
    try {
      const state = await liveApi.forkAt(liveId, detail.id, nativeEventId)
      navigate(taskLiveRuntimeHref({ liveId, state }))
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
    historyInteractionBlocked,
    retryHistoryInteraction,
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
    visibleNativeSessions,
    nativeHasMore: Boolean(nativeCursor || nativeBodyCursor),
    nativeLoadingMore: nativeLoadingMore || nativeBodyLoading,
    nativeBodySearchActive: review.filters.search.trim().length>=2
      && !embedded && !review.filters.projectId && review.filters.status==='all',
    nativeBodyPartial,
    nativeBodyError,
    loadMoreNativeSessions,
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
    nativeTurnIndex,
    onTurnRailSelect,
    pageIncomplete,
    isBackward,
    isFiltered,
    atStart,
    onReaderScroll,
    emptyLabel,
    toggleEventVisibility,
    noteReaderUserIntent,
    sendReviewMessage,
    forkReviewAt,
  }
}
