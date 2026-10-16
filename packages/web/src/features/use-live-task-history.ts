import type { TaskLiveRuntimeLocation } from './task-live-runtime'
import type { LiveTaskState } from './live-task-state'
import { useCallback, useEffect } from 'react'
import { liveApi } from '../client/live'
import { LIVE_TASK_SNAPSHOT_PAGE_LIMIT, historyPageBlock, aggregateHistoryPage, compactHistoryBlocks, refreshLatestHistoryBlock, captureLiveReaderAnchor, restoreLiveReaderAnchor, splitLiveProjectionItems, prependUniqueLiveProjectionItems, appendUniqueLiveProjectionItems } from './live-task-history-window'
import { projectLiveInputHistory, projectLiveSnapshotEntries } from './live-task-projection'

/** 只拥有 Reader 用户意图、双向历史分页与滚动位置保护。 */
export function useLiveTaskHistory({ current, session }: {
  current: TaskLiveRuntimeLocation | null
  session: LiveTaskState
}) {
  const {
    state,
    setState,
    projection,
    setProjection,
    historyPage,
    setHistoryPage,
    historyLoading,
    setHistoryLoading,
    historyPagingArmed,
    setHistoryPagingArmed,
    historyPagingDirection,
    setHistoryPagingDirection,
    setSyncError,
    setNewRecords,
    setInputHistory,
    readerRef,
    historyLoadSentinelRef,
    historyNewerSentinelRef,
    lastReaderScrollTopRef,
    historyAtLatestRef,
    historyBlocksRef,
    projectionRef,
    followControllerRef,
    leafIdRef,
    snapshotBaseActiveCountRef,
    roundProjectorRef
  } = session
  const markReaderUserIntent = useCallback((direction?: 'older' | 'newer') => {
    followControllerRef.current.markUserIntent()
    setHistoryPagingArmed(true)
    if (direction) setHistoryPagingDirection(direction)
  }, [])

  const onReaderScroll = useCallback(() => {
    const reader = readerRef.current
    if (!reader) return
    const previousTop = lastReaderScrollTopRef.current
    if (historyPagingArmed && Math.abs(reader.scrollTop - previousTop) > 1) {
      setHistoryPagingDirection(reader.scrollTop < previousTop ? 'older' : 'newer')
    }
    lastReaderScrollTopRef.current = reader.scrollTop
    const distance = Math.max(0, reader.scrollHeight - reader.clientHeight - reader.scrollTop)
    const following = followControllerRef.current.observeScroll(distance)
    if (following) setNewRecords(false)
  }, [historyPagingArmed])

  const replaceHistoryWindow = useCallback(async (edge: 'earliest' | 'latest') => {
    if (!current || historyLoading) return
    const reader = readerRef.current
    setHistoryLoading(true)
    try {
      const snapshot = await liveApi.snapshot(
        current.liveId,
        current.runtimeSessionId,
        undefined,
        { edge, limit: LIVE_TASK_SNAPSHOT_PAGE_LIMIT },
      )
      const projected = projectLiveSnapshotEntries(snapshot.entries)
      const nextProjection = splitLiveProjectionItems(projected, edge === 'latest' && snapshot.state.isStreaming)
      roundProjectorRef.current.reset()
      setProjection(nextProjection)
      historyBlocksRef.current = [historyPageBlock(snapshot, projected)]
      setHistoryPage(aggregateHistoryPage(historyBlocksRef.current))
      historyAtLatestRef.current = snapshot.page?.hasLater !== true
      setState(snapshot.state)
      setInputHistory(projectLiveInputHistory(projected))
      snapshotBaseActiveCountRef.current = nextProjection.active.length
      if (edge === 'latest') leafIdRef.current = snapshot.leafId ?? undefined
      setSyncError('')
      if (edge === 'latest') {
        followControllerRef.current.restore()
        setNewRecords(false)
      } else {
        followControllerRef.current.markUserIntent()
      }
      window.requestAnimationFrame(() => {
        const currentReader = readerRef.current
        if (!currentReader || currentReader !== reader) return
        currentReader.scrollTop = edge === 'earliest'
          ? 0
          : Math.max(0, currentReader.scrollHeight - currentReader.clientHeight)
        lastReaderScrollTopRef.current = currentReader.scrollTop
      })
    } catch (reason) {
      setSyncError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setHistoryLoading(false)
      setHistoryPagingArmed(false)
      setHistoryPagingDirection(null)
    }
  }, [current, historyLoading])

  const jumpEarliest = useCallback(() => replaceHistoryWindow('earliest'), [replaceHistoryWindow])
  const jumpLatest = useCallback(() => replaceHistoryWindow('latest'), [replaceHistoryWindow])

  useEffect(() => {
    if (!historyAtLatestRef.current || historyLoading) return
    const totalItems = projection.stable.length + projection.active.length
    if (totalItems <= LIVE_TASK_SNAPSHOT_PAGE_LIMIT * LIVE_TASK_HISTORY_WINDOW_MAX_PAGES) return
    void replaceHistoryWindow('latest')
  }, [historyLoading, projection.active.length, projection.stable.length, replaceHistoryWindow])

  const loadEarlier = useCallback(async () => {
    if (!current || !historyPagingArmed || historyPagingDirection !== 'older' || historyLoading || !historyPage?.hasEarlier || !historyPage.before) return
    const reader = readerRef.current
    const previousScrollHeight = reader?.scrollHeight ?? 0
    const previousScrollTop = reader?.scrollTop ?? 0
    setHistoryLoading(true)
    try {
      const snapshot = await liveApi.snapshot(
        current.liveId,
        current.runtimeSessionId,
        undefined,
        { before: historyPage.before, limit: LIVE_TASK_SNAPSHOT_PAGE_LIMIT },
      )
      const older = projectLiveSnapshotEntries(snapshot.entries)
      const savedAnchor = reader ? captureLiveReaderAnchor(reader) : null
      const baseBlocks = historyAtLatestRef.current
        ? refreshLatestHistoryBlock(historyBlocksRef.current, projectionRef.current)
        : historyBlocksRef.current
      const compacted = compactHistoryBlocks(
        [historyPageBlock(snapshot, older), ...baseBlocks],
        'older',
      )
      historyBlocksRef.current = compacted.blocks
      const nextPage = aggregateHistoryPage(compacted.blocks)
      historyAtLatestRef.current = nextPage.hasLater !== true
      roundProjectorRef.current.reset()
      setProjection(previous => ({
        stable: prependUniqueLiveProjectionItems(older, previous.stable)
          .filter(item => !compacted.removedIds.has(item.id)),
        active: previous.active.filter(item => !compacted.removedIds.has(item.id)),
      }))
      setHistoryPage(nextPage)
      setState(snapshot.state)
      setSyncError('')
      window.requestAnimationFrame(() => {
        const currentReader = readerRef.current
        if (!currentReader || currentReader !== reader) return
        if (savedAnchor) restoreLiveReaderAnchor(currentReader, savedAnchor)
        else {
          const addedHeight = Math.max(0, currentReader.scrollHeight - previousScrollHeight)
          currentReader.scrollTop = previousScrollTop + addedHeight
        }
        lastReaderScrollTopRef.current = currentReader.scrollTop
      })
    } catch (reason) {
      setSyncError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setHistoryLoading(false)
      setHistoryPagingArmed(false)
      setHistoryPagingDirection(null)
    }
  }, [current, historyLoading, historyPage?.before, historyPage?.hasEarlier, historyPagingArmed, historyPagingDirection])

  const loadNewer = useCallback(async () => {
    if (!current || !historyPagingArmed || historyPagingDirection !== 'newer' || historyLoading || !historyPage?.hasLater || !historyPage.after) return
    setHistoryLoading(true)
    try {
      const snapshot = await liveApi.snapshot(
        current.liveId,
        current.runtimeSessionId,
        undefined,
        { after: historyPage.after, limit: LIVE_TASK_SNAPSHOT_PAGE_LIMIT },
      )
      const newer = projectLiveSnapshotEntries(snapshot.entries)
      const reachedLatest = snapshot.page?.hasLater !== true
      const newerProjection = splitLiveProjectionItems(newer, reachedLatest && snapshot.state.isStreaming)
      const savedAnchor = readerRef.current ? captureLiveReaderAnchor(readerRef.current) : null
      const compacted = compactHistoryBlocks(
        [...historyBlocksRef.current, historyPageBlock(snapshot, newer)],
        'newer',
      )
      historyBlocksRef.current = compacted.blocks
      const nextPage = aggregateHistoryPage(compacted.blocks)
      historyAtLatestRef.current = nextPage.hasLater !== true
      roundProjectorRef.current.reset()
      setProjection(previous => ({
        stable: appendUniqueLiveProjectionItems(previous.stable, newerProjection.stable)
          .filter(item => !compacted.removedIds.has(item.id)),
        active: (reachedLatest
          ? appendUniqueLiveProjectionItems(previous.active, newerProjection.active)
          : previous.active)
          .filter(item => !compacted.removedIds.has(item.id)),
      }))
      setHistoryPage(nextPage)
      if (reachedLatest) {
        leafIdRef.current = snapshot.leafId ?? leafIdRef.current
        setNewRecords(false)
      }
      setState(snapshot.state)
      setSyncError('')
      if (savedAnchor) {
        window.requestAnimationFrame(() => {
          const reader = readerRef.current
          if (!reader) return
          restoreLiveReaderAnchor(reader, savedAnchor)
          lastReaderScrollTopRef.current = reader.scrollTop
        })
      }
    } catch (reason) {
      setSyncError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setHistoryLoading(false)
      setHistoryPagingArmed(false)
      setHistoryPagingDirection(null)
    }
  }, [current, historyLoading, historyPage?.after, historyPage?.hasLater, historyPagingArmed, historyPagingDirection])

  useEffect(() => {
    const sentinel = historyLoadSentinelRef.current
    const reader = readerRef.current
    if (!sentinel || !reader || !historyPagingArmed || historyPagingDirection !== 'older' || historyLoading || !historyPage?.hasEarlier || !historyPage.before) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadEarlier()
    }, { root: reader, rootMargin: '360px 0px 0px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [historyLoading, historyPage?.before, historyPage?.hasEarlier, historyPagingArmed, historyPagingDirection, loadEarlier])

  useEffect(() => {
    const sentinel = historyNewerSentinelRef.current
    const reader = readerRef.current
    if (!sentinel || !reader || !historyPagingArmed || historyPagingDirection !== 'newer' || historyLoading || !historyPage?.hasLater || !historyPage.after) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadNewer()
    }, { root: reader, rootMargin: '0px 0px 360px 0px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [historyLoading, historyPage?.after, historyPage?.hasLater, historyPagingArmed, historyPagingDirection, loadNewer])


  return { markReaderUserIntent, onReaderScroll, jumpEarliest, jumpLatest }
}
