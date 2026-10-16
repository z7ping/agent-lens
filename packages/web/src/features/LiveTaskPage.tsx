import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type {
  LiveCommandDto,
  LiveEventDto,
  LiveHistoryIndexDto,
  LiveInputCapabilitiesDto,
  LiveMessageActionContributionDto,
  LiveMessageDto,
  LiveModelControlDto,
  LiveQueueStateDto,
  LiveRuntimeActionContributionDto,
  LiveRuntimeDisclosureContributionDto,
  LiveRuntimeStateDto,
  LiveSnapshotDto,
  LiveThinkingControlDto,
} from '@agent-lens/protocol'
import { AgentLensApi } from '../client/api'
import { liveApi, type LiveProductMetadata } from '../client/live'
import { ComposerPillSelect } from '../components/ComposerPillSelect'
import { CopyableCodeBlock } from '../components/CopyableCodeBlock'
import { LocalPathActions } from '../components/LocalPathActions'
import { LiveRuntimeDisclosures } from '../components/LiveRuntimeDisclosures'
import {
  LiveMarkdownComposer,
  type LiveMarkdownComposerDraft,
  type LiveMarkdownComposerHandle,
} from '../components/LiveMarkdownComposer'
import {
  liveComposerDraftKey,
  readLiveComposerDraft,
  writeLiveComposerDraft,
} from '../components/live-composer-session-state'
import { OperationProgress } from '../components/StateViews'
import { Button, IconButton } from '../components/ui'
import { LiveExtensionPrompt } from './LiveExtensionPrompt'
import { useLiveTaskState } from './live-task-state'
import { useLiveTaskRuntime } from './use-live-task-runtime'
import { emptyLiveQueue, restoredQueueDrafts, queueTextMessage, firstUserEntryCursor, type LiveQueueMode, type PendingQueueSubmission, type RestoredQueueDraft, type LiveQueueListItem } from './live-task-queue'
import { messageText, messageHasAttachments, optimisticMessageAttachments, unsupportedInput } from './live-task-input'
import {
  LIVE_TASK_SNAPSHOT_PAGE_LIMIT,
  type LiveHistoryPageBlock,
  historyPageBlock,
  aggregateHistoryPage,
  compactHistoryBlocks,
  refreshLatestHistoryBlock,
  captureLiveReaderAnchor,
  restoreLiveReaderAnchor,
  splitLiveProjectionItems,
  prependUniqueLiveProjectionItems,
  appendUniqueLiveProjectionItems,
  loadBoundedRecoverySnapshot,
} from './live-task-history-window'
import { GenericLiveRound, StableLiveRounds } from './LiveTaskTimeline'
import { UiIcon } from '../components/UiIcon'
import { AgentLogo } from '../components/AgentLogo'
import {
  appendLiveInputHistory,
  appendOptimisticLiveUserMessage,
  projectLiveInputHistory,
  projectLiveSnapshotEntries,
  LiveTaskRoundProjector,
  liveEventChangesTaskTranscript,
  mergeLiveActiveProjectionItems,
  reduceLiveTaskEvent,
  settleLiveTaskProjectionItems,
  type LiveTaskProjectionAttachment,
  type LiveTaskProjectionItem,
} from './live-task-projection'
import { LiveFollowController } from './live-follow-controller'
import { parseTaskLiveRuntimeLocation, taskLiveRuntimeStatus, shouldRecoverLiveOnVisible, sameLiveRuntimeState, runtimeStateFromEvent } from './task-live-runtime'
import { TaskHeader } from './TaskHeader'
import { TaskSurface, type TaskTurnRailData } from './TaskSurface'
import { ToolOutputContent } from './ToolOutputContent'
import { workspaceDisplayName } from './task-detail-model'

function statusLabel(
  state: LiveRuntimeStateDto | null,
  t: ReturnType<typeof useTranslation>['t'],
  activity?: 'running' | 'compacting' | 'idle' | null,
): string {
  if (activity === 'compacting') return t('center.runtimeStatus.compacting')
  if (!state) return t('center.runtimeStatus.initializing')
  const status = taskLiveRuntimeStatus(state)
  return t(`center.runtimeStatus.${status}`)
}

export function LiveTaskPage({ embedded = false }: { embedded?: boolean }) {
  const { t, i18n } = useTranslation('task')
  const location = useLocation()
  const navigate = useNavigate()
  const hostApi = useMemo(() => new AgentLensApi(), [])
  const current = useMemo(() => parseTaskLiveRuntimeLocation(location.pathname), [location.pathname])
  const composerDraftKey = useMemo(
    () => current ? liveComposerDraftKey(current.liveId, current.runtimeSessionId) : '',
    [current?.liveId, current?.runtimeSessionId],
  )
  const session = useLiveTaskState()
  const {
    product,
    setProduct,
    state,
    setState,
    projection,
    setProjection,
    historyPage,
    setHistoryPage,
    historyIndex,
    setHistoryIndex,
    historyLoading,
    setHistoryLoading,
    historyPagingArmed,
    setHistoryPagingArmed,
    historyPagingDirection,
    setHistoryPagingDirection,
    messageActions,
    setMessageActions,
    messageActionPending,
    setMessageActionPending,
    runtimeDisclosures,
    setRuntimeDisclosures,
    runtimeActionPending,
    setRuntimeActionPending,
    commands,
    setCommands,
    modelControl,
    setModelControl,
    thinking,
    setThinking,
    extension,
    setExtension,
    extensionPending,
    setExtensionPending,
    streamingBehavior,
    setStreamingBehavior,
    queue,
    setQueue,
    pendingQueue,
    setPendingQueue,
    restoredQueue,
    setRestoredQueue,
    queueMutationPending,
    setQueueMutationPending,
    connected,
    setConnected,
    activityStatus,
    setActivityStatus,
    bootstrapTarget,
    setBootstrapTarget,
    syncError,
    setSyncError,
    newRecords,
    setNewRecords,
    composerExpanded,
    setComposerExpanded,
    startupQueued,
    setStartupQueued,
    interruptNotice,
    setInterruptNotice,
    busy,
    setBusy,
    error,
    setError,
    pathError,
    setPathError,
    composerHasContent,
    setComposerHasContent,
    composerAttachmentPending,
    setComposerAttachmentPending,
    inputHistory,
    setInputHistory,
    draft,
    setDraft,
    composerRef,
    readerRef,
    historyLoadSentinelRef,
    historyNewerSentinelRef,
    lastReaderScrollTopRef,
    historyAtLatestRef,
    historyIndexAnchorCursorRef,
    historyBlocksRef,
    projectionRef,
    runtimeStateRef,
    followControllerRef,
    followFrameRef,
    followReleaseFrameRef,
    startupSendingRef,
    leafIdRef,
    snapshotBaseActiveCountRef,
    liveTurnRevisionRef,
    roundProjectorRef,
    queueRevisionRef
  } = session

  const setComposerValue = useCallback((value: string) => {
    setDraft(currentDraft => ({ revision: currentDraft.revision + 1, value }))
    setComposerHasContent(Boolean(value.trim()))
  }, [])

  const clearComposer = useCallback(() => {
    if (composerRef.current) composerRef.current.clear()
    else setComposerValue('')
  }, [setComposerValue])

  useEffect(() => {
    setComposerValue(composerDraftKey ? readLiveComposerDraft(composerDraftKey) : '')
  }, [composerDraftKey, setComposerValue])

  useLiveTaskRuntime({ current, t, session })

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

  const canQueueWhileStreaming = Boolean(
    product?.capabilities.includes('steer') || product?.capabilities.includes('queue'),
  )
  const canStageStartup = Boolean(
    current
    && product?.capabilities.includes('send')
    && state?.status === 'initializing'
    && !startupQueued
    && !busy
    && !queueMutationPending
    && !composerAttachmentPending,
  )
  const canSubmit = Boolean(
    current
    && product?.capabilities.includes('send')
    && (
      canStageStartup
      || (
        state?.status === 'ready'
        && (!state.isStreaming || canQueueWhileStreaming)
      )
    )
    && !startupQueued
    && !busy
    && !queueMutationPending
    && !composerAttachmentPending,
  )
  const canInterrupt = Boolean(
    current
    && state?.isStreaming
    && product?.capabilities.includes('interrupt')
    && !busy
    && !queueMutationPending,
  )

  const send = useCallback(async (message: LiveMessageDto, requestedBehavior?: LiveQueueMode) => {
    if (!current || !product || !state || !canSubmit) return
    const unsupported = unsupportedInput(message, product.inputCapabilities)
    if (unsupported) {
      setError(t('live.unsupportedInput', { type: t(`live.input.${unsupported}`) }))
      return
    }
    if (state.status === 'initializing') {
      if (messageHasAttachments(message)) {
        setError(t('live.startupAttachmentRequiresReady'))
        return
      }
      setStartupQueued(message)
      clearComposer()
      composerRef.current?.focus({ preventScroll: true })
      return
    }
    const preferredBehavior = requestedBehavior ?? streamingBehavior
    const behavior = state.isStreaming
      ? preferredBehavior === 'steer' && product.capabilities.includes('steer')
        ? 'steer' as const
        : product.capabilities.includes('queue')
          ? 'follow-up' as const
          : 'steer' as const
      : 'normal' as const
    const optimisticText = messageText(message)
    const pending = behavior !== 'normal' && optimisticText
      ? { id: `${behavior}-${Date.now()}-${Math.random().toString(36).slice(2)}`, mode: behavior, text: optimisticText }
      : null

    setBusy(true)
    setError('')
    const optimisticAttachments = behavior === 'normal'
      ? await optimisticMessageAttachments(message)
      : []
    const optimisticId = behavior === 'normal' && (optimisticText || optimisticAttachments.length)
      ? `user:${Date.now()}-${Math.random().toString(36).slice(2)}`
      : null
    if (behavior === 'normal') liveTurnRevisionRef.current += 1
    if (behavior === 'normal' && optimisticId) {
      setProjection(previous => ({
        ...previous,
        active: appendOptimisticLiveUserMessage(
          previous.active,
          optimisticText,
          optimisticId,
          optimisticAttachments,
        ),
      }))
    }
    if (pending) setPendingQueue(previous => [...previous, pending])
    clearComposer()
    try {
      await liveApi.send(current.liveId, current.runtimeSessionId, message, behavior)
      if (optimisticText) setInputHistory(previous => appendLiveInputHistory(previous, optimisticText))
      if (behavior === 'normal') {
        setState(previous => previous ? { ...previous, isStreaming: true } : previous)
      }
      composerRef.current?.focus({ preventScroll: true })
    } catch (reason) {
      if (optimisticId) {
        setProjection(previous => ({
          ...previous,
          active: previous.active.filter(item => item.id !== optimisticId),
        }))
      }
      composerRef.current?.restoreMessage(message)
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (pending) setPendingQueue(previous => previous.filter(item => item.id !== pending.id))
      setBusy(false)
    }
  }, [canSubmit, clearComposer, current, product, state, streamingBehavior, t])

  useEffect(() => {
    if (!current || !product || state?.status !== 'ready' || !startupQueued || startupSendingRef.current) return
    const message = startupQueued
    const optimisticText = messageText(message)
    const optimisticId = optimisticText
      ? `user:${Date.now()}-${Math.random().toString(36).slice(2)}`
      : null

    startupSendingRef.current = true
    liveTurnRevisionRef.current += 1
    setBusy(true)
    setError('')
    setStartupQueued(currentMessage => currentMessage === message ? null : currentMessage)
    if (optimisticText && optimisticId) {
      setProjection(previous => ({
        ...previous,
        active: appendOptimisticLiveUserMessage(previous.active, optimisticText, optimisticId),
      }))
    }

    void liveApi.send(current.liveId, current.runtimeSessionId, message, 'normal').then(() => {
      if (optimisticText) setInputHistory(previous => appendLiveInputHistory(previous, optimisticText))
      setState(previous => previous ? { ...previous, isStreaming: true } : previous)
      composerRef.current?.focus({ preventScroll: true })
    }, reason => {
      if (optimisticId) {
        setProjection(previous => ({
          ...previous,
          active: previous.active.filter(item => item.id !== optimisticId),
        }))
      }
      composerRef.current?.restoreMessage(message)
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      startupSendingRef.current = false
      setBusy(false)
    })
  }, [current, product, startupQueued, state?.status])

  const editStartupQueued = useCallback(() => {
    if (!startupQueued) return
    const message = startupQueued
    setStartupQueued(null)
    composerRef.current?.restoreMessage(message)
    composerRef.current?.focus({ preventScroll: true })
  }, [startupQueued])

  const interrupt = useCallback(async () => {
    if (!current || !canInterrupt) return
    setBusy(true)
    setError('')
    try {
      const result = await liveApi.interrupt(current.liveId, current.runtimeSessionId)
      const restored = result.restoredQueue ? restoredQueueDrafts(result.restoredQueue) : []
      setRestoredQueue(restored)
      setQueue(emptyLiveQueue())
      setPendingQueue([])
      setProjection(previous => ({
        ...previous,
        active: settleLiveTaskProjectionItems(previous.active),
      }))
      setState(previous => previous ? { ...previous, isStreaming: false, pendingMessageCount: 0 } : previous)
      setInterruptNotice(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
      composerRef.current?.focus({ preventScroll: true })
    }
  }, [canInterrupt, current])

  const removeQueued = useCallback(async (mode: LiveQueueMode, queueIndex: number, text: string) => {
    if (!current || !product?.capabilities.includes('queue') || queueMutationPending) return
    setQueueMutationPending(true)
    setError('')
    try {
      const cleared = await liveApi.clearQueue(current.liveId, current.runtimeSessionId)
      const steering = [...cleared.steering]
      const followUp = [...cleared.followUp]
      const target = mode === 'steer' ? steering : followUp
      const resolvedIndex = target[queueIndex] === text ? queueIndex : target.indexOf(text)
      if (resolvedIndex >= 0) target.splice(resolvedIndex, 1)

      setQueue(emptyLiveQueue())
      for (const message of steering) {
        await liveApi.send(current.liveId, current.runtimeSessionId, queueTextMessage(message), 'steer')
      }
      for (const message of followUp) {
        await liveApi.send(current.liveId, current.runtimeSessionId, queueTextMessage(message), 'follow-up')
      }
      setQueue({ steering, followUp })
      setState(previous => previous
        ? { ...previous, pendingMessageCount: steering.length + followUp.length }
        : previous)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setQueueMutationPending(false)
      composerRef.current?.focus({ preventScroll: true })
    }
  }, [current, product?.capabilities, queueMutationPending])

  const editRestoredQueue = useCallback((item: RestoredQueueDraft) => {
    setComposerValue(item.text)
    setStreamingBehavior(item.mode)
    setRestoredQueue(previous => previous.filter(candidate => candidate.id !== item.id))
    requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }))
  }, [setComposerValue])

  const removeRestoredQueue = useCallback((id: string) => {
    setRestoredQueue(previous => previous.filter(item => item.id !== id))
    composerRef.current?.focus({ preventScroll: true })
  }, [])

  const terminate = useCallback(async () => {
    if (!current || busy) return
    setBusy(true)
    setError('')
    try {
      await liveApi.terminate(current.liveId, current.runtimeSessionId)
      navigate('/review')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setBusy(false)
    }
  }, [busy, current, navigate])

  const changeModel = useCallback(async (value: string) => {
    if (!current || !modelControl || busy) return
    setBusy(true)
    setError('')
    try {
      const nextState = await liveApi.setModelControl(current.liveId, current.runtimeSessionId, value)
      setState(nextState)
      setModelControl(await liveApi.modelControl(current.liveId, current.runtimeSessionId))
      composerRef.current?.focus({ preventScroll: true })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [busy, current, modelControl])

  const answerExtension = useCallback(async (value: unknown) => {
    if (!current || !extension || extensionPending) return
    setExtensionPending(true)
    setError('')
    try {
      await liveApi.respondToExtension(current.liveId, current.runtimeSessionId, extension.requestId, value)
      setExtension(null)
      composerRef.current?.focus({ preventScroll: true })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setExtensionPending(false)
    }
  }, [current, extension, extensionPending])

  const searchWorkspaceReferences = useCallback((query: string) => {
    if (!current || !product?.capabilities.includes('workspace-file-reference')) {
      return Promise.resolve([])
    }
    return liveApi.workspaceFileReferences(current.liveId, current.runtimeSessionId, query, 20)
  }, [current, product])

  const runMessageAction = useCallback(async (
    action: LiveMessageActionContributionDto,
    item: Extract<LiveTaskProjectionItem, { kind: 'message' }>,
  ) => {
    if (!current || !item.entryId || messageActionPending) return
    if (action.requiresIdle && state?.isStreaming) return
    const pendingKey = `${action.actionId}:${item.entryId}`
    setMessageActionPending(pendingKey)
    setError('')
    try {
      const result = await liveApi.executeMessageAction(
        current.liveId,
        current.runtimeSessionId,
        action.actionId,
        item.entryId,
      )
      if (result.outcome === 'open-runtime' && result.runtime) {
        if (result.draftText) {
          writeLiveComposerDraft(
            liveComposerDraftKey(current.liveId, result.runtime.runtimeSessionId),
            result.draftText,
          )
        }
        navigate(`/review/live/${encodeURIComponent(current.liveId)}/${encodeURIComponent(result.runtime.runtimeSessionId)}`)
        return
      }

      const snapshot = await liveApi.snapshot(
        current.liveId,
        current.runtimeSessionId,
        undefined,
        { limit: LIVE_TASK_SNAPSHOT_PAGE_LIMIT },
      )
      const projected = projectLiveSnapshotEntries(snapshot.entries)
      const nextProjection = splitLiveProjectionItems(projected, snapshot.state.isStreaming)
      setState(snapshot.state)
      setProjection(nextProjection)
      historyBlocksRef.current = [historyPageBlock(snapshot, projected)]
      setHistoryPage(aggregateHistoryPage(historyBlocksRef.current))
      historyAtLatestRef.current = snapshot.page?.hasLater !== true
      setInputHistory(projectLiveInputHistory(projected))
      snapshotBaseActiveCountRef.current = nextProjection.active.length
      leafIdRef.current = snapshot.leafId ?? undefined
      if (typeof result.draftText === 'string') setComposerValue(result.draftText)
      composerRef.current?.focus({ preventScroll: true })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setMessageActionPending(null)
    }
  }, [current, messageActionPending, navigate, setComposerValue, state?.isStreaming])

  const runRuntimeAction = useCallback(async (action: LiveRuntimeActionContributionDto) => {
    if (!current || runtimeActionPending) return
    setRuntimeActionPending(action.actionId)
    setError('')
    try {
      const result = await liveApi.executeRuntimeAction(
        current.liveId,
        current.runtimeSessionId,
        action.actionId,
      )
      setState(result.runtime)
      const disclosures = await liveApi.runtimeDisclosures(
        current.liveId,
        current.runtimeSessionId,
      ).catch(() => [])
      setRuntimeDisclosures(disclosures)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setRuntimeActionPending(null)
    }
  }, [current, runtimeActionPending])

  const changeThinking = useCallback(async (value: string) => {
    if (!current || !thinking || busy) return
    setBusy(true)
    setError('')
    try {
      const nextState = await liveApi.setThinkingControl(current.liveId, current.runtimeSessionId, value)
      setState(nextState)
      const confirmed = await liveApi.thinkingControl(current.liveId, current.runtimeSessionId)
      setThinking(confirmed)
      if (confirmed?.value !== value) {
        throw new Error(t('live.thinkingNotApplied', { requested: value, actual: confirmed?.value ?? '—' }))
      }
      composerRef.current?.focus({ preventScroll: true })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [busy, current, thinking, t])

  const jumpToIndexedRound = useCallback(async (item: TaskTurnRailData) => {
    if (!current || historyLoading) return
    const targetOrdinal = item.ordinal
    if (!item.cursor && !targetOrdinal) return
    setHistoryLoading(true)
    try {
      const cursor = item.cursor ?? (
        await liveApi.historyIndex(
          current.liveId,
          current.runtimeSessionId,
          { fromOrdinal: targetOrdinal, limit: 1 },
        )
      ).items[0]?.cursor
      if (!cursor) throw new Error(`Live round ${targetOrdinal ?? ''} was not found`)
      const snapshot = await liveApi.snapshot(
        current.liveId,
        current.runtimeSessionId,
        undefined,
        { around: cursor, limit: LIVE_TASK_SNAPSHOT_PAGE_LIMIT },
      )
      const projected = projectLiveSnapshotEntries(snapshot.entries)
      const atLatest = snapshot.page?.hasLater !== true
      const nextProjection = splitLiveProjectionItems(projected, atLatest && snapshot.state.isStreaming)
      roundProjectorRef.current.reset()
      setProjection(nextProjection)
      historyBlocksRef.current = [historyPageBlock(snapshot, projected)]
      setHistoryPage(aggregateHistoryPage(historyBlocksRef.current))
      historyAtLatestRef.current = atLatest
      setState(snapshot.state)
      setInputHistory(projectLiveInputHistory(projected))
      snapshotBaseActiveCountRef.current = nextProjection.active.length
      if (atLatest) leafIdRef.current = snapshot.leafId ?? leafIdRef.current
      followControllerRef.current.markUserIntent()
      setSyncError('')
    } catch (reason) {
      setSyncError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setHistoryLoading(false)
      setHistoryPagingArmed(false)
      setHistoryPagingDirection(null)
    }
  }, [current, historyLoading])

  const roundSegments = useMemo(
    () => roundProjectorRef.current.projectSegmented(projection.stable, projection.active),
    [projection.stable, projection.active],
  )
  const stableEagerTailCount = Math.max(0, 2 - roundSegments.active.length)
  const turnRailItems = useMemo(() => {
    const segments = [...roundSegments.stable, ...roundSegments.active]
    const firstLoadedCursor = segments
      .map(round => round.model.semanticId ?? round.model.id)
      .find(semanticId => semanticId.startsWith('live-round:'))
      ?.slice('live-round:'.length)
    const indexedFirstOrdinal = firstLoadedCursor
      ? historyIndex?.items.find(item => item.cursor === firstLoadedCursor)?.ordinal
      : undefined
    const firstGlobalOrdinal = historyPage?.rounds?.firstOrdinal ?? indexedFirstOrdinal
    return segments.map(round => {
      const localOrdinal = round.model.ordinal
      const ordinal = firstGlobalOrdinal && localOrdinal
        ? firstGlobalOrdinal + localOrdinal - 1
        : localOrdinal
      const semanticId = round.model.semanticId ?? round.model.id
      const cursor = semanticId.startsWith('live-round:')
        ? semanticId.slice('live-round:'.length)
        : undefined
      return {
        id: round.model.id,
        semanticId,
        ...(cursor ? { cursor } : {}),
        ...(ordinal ? { ordinal } : {}),
        label: ordinal ? t('surface.roundOrdinal', { count: ordinal }) : round.model.label,
        preview: round.model.preview,
        error: round.model.errorCount > 0,
        state: round.model.state,
        loaded: true,
      } satisfies TaskTurnRailData
    })
  }, [historyIndex?.items, historyPage?.rounds?.firstOrdinal, roundSegments, t])
  const loadedRoundMax = turnRailItems.reduce((max, item) => Math.max(max, item.ordinal ?? 0), 0)
  const turnRailTotal = Math.max(
    historyPage?.rounds?.total ?? 0,
    historyIndex?.total ?? 0,
    loadedRoundMax,
  ) || undefined
  const itemCount = projection.stable.length + projection.active.length

  if (!current) {
    return <main className="pi-live-page pi-live-page-embedded">
      <div className="pi-live-error" role="alert">{error || t('live.invalidRuntime')}</div>
    </main>
  }

  const agentLabel = product?.displayName ?? current.liveId
  const workspace = workspaceDisplayName(state?.workspacePath)
  const title = state?.title?.trim() || workspace || t('center.history.genericAgentTask', { agent: agentLabel })
  const runtimeStatus = statusLabel(state, t, activityStatus)
  const streamSupported = product?.capabilities.includes('stream') === true
  const connectionLabel = streamSupported
    ? connected ? t('live.connected') : t('live.connecting')
    : runtimeStatus
  const submitMessage = () => {
    const message = composerRef.current?.getMessage()
    if (message) void send(message)
  }

  const queueItems: LiveQueueListItem[] = [
    ...pendingQueue.map(item => ({ ...item, active: true, pending: true })),
    ...queue.steering.map((text, index) => ({
      id: `active-steer-${index}`,
      mode: 'steer' as const,
      text,
      active: true,
      queueIndex: index,
    })),
    ...queue.followUp.map((text, index) => ({
      id: `active-follow-${index}`,
      mode: 'follow-up' as const,
      text,
      active: true,
      queueIndex: index,
    })),
    ...restoredQueue.map(item => ({ ...item, active: false })),
  ]

  return <main className={`pi-live-page live-task-page ${embedded ? 'pi-live-page-embedded' : ''}`}>
    <TaskSurface
      mode="live"
      className="pi-live-workspace live-task-workspace"
      boundaryNavigation={{
        startDisabled: historyLoading,
        endDisabled: historyLoading,
        onStart: jumpEarliest,
        onEnd: jumpLatest,
      }}
      turnRailItems={turnRailItems}
      turnRailTotal={turnRailTotal}
      onTurnRailSelect={jumpToIndexedRound}
    >
      <TaskHeader
        marker={<AgentLogo sourceId={product?.productId ?? current.liveId} size="normal"/>}
        agent={agentLabel}
        context={workspace || t('header.unlinkedProject')}
        status={runtimeStatus}
        title={title}
        metrics={[]}
        infoItems={[
          { label: t('live.runtimeId'), value: current.runtimeSessionId },
          ...(state?.workspacePath ? [{
            label: t('header.workspace'),
            value: <span className="local-path-value">
              <code title={state.workspacePath}>{state.workspacePath}</code>
              <LocalPathActions
                path={state.workspacePath}
                onOpen={path => {
                  setPathError('')
                  return hostApi.openHostPath(path)
                }}
                onError={reason => setPathError(reason instanceof Error ? reason.message : String(reason))}
              />
            </span>,
          }] : []),
        ]}
        actions={<>
          {canInterrupt && <Button size="small" variant="danger" disabled={busy} onClick={() => void interrupt()}>{t('live.interrupt')}</Button>}
          <Button size="small" disabled={busy || runtimeActionPending !== null} onClick={() => void terminate()}>{t('live.terminate')}</Button>
        </>}
      />

      <div
        ref={readerRef}
        className="pi-live-reader live-task-reader"
        onScroll={onReaderScroll}
        onWheel={event => markReaderUserIntent(event.deltaY < 0 ? 'older' : 'newer')}
        onTouchStart={() => markReaderUserIntent()}
        onPointerDown={() => markReaderUserIntent()}
      >
        <div className="pi-live-document live-task-document">
          {historyPage?.hasEarlier && <div
            ref={historyLoadSentinelRef}
            className={`live-task-history-sentinel ${historyLoading ? 'is-loading' : ''}`}
            aria-hidden="true"
          />}
          <LiveRuntimeDisclosures
            items={runtimeDisclosures}
            language={i18n.resolvedLanguage ?? i18n.language}
            pendingAction={runtimeActionPending}
            onAction={action => { void runRuntimeAction(action) }}
          />
          {runtimeDisclosures.every(item => !item.lifecycle) && (!state || state.status === 'initializing') && !error && <div className="pi-live-startup-spotlight">
            <OperationProgress
              statusLabel={runtimeStatus}
              title={t('live.loadingTitle')}
              description={t('live.loadingDescription')}
            />
          </div>}
          <StableLiveRounds
            rounds={roundSegments.stable}
            agentLabel={agentLabel}
            eagerTailCount={stableEagerTailCount}
            messageActions={messageActions}
            actionPending={messageActionPending}
            runtimeStreaming={state?.isStreaming ?? false}
            onMessageAction={runMessageAction}
          />
          {roundSegments.active.map((round, index) => <GenericLiveRound
            key={round.model.id}
            projection={round}
            agentLabel={agentLabel}
            eager={round.model.state === 'running' || index >= roundSegments.active.length - 2}
            messageActions={messageActions}
            actionPending={messageActionPending}
            runtimeStreaming={state?.isStreaming ?? false}
            showResponsePending={Boolean(state?.isStreaming) && index === roundSegments.active.length - 1}
            onMessageAction={runMessageAction}
          />)}
          {historyPage?.hasLater && <div
            ref={historyNewerSentinelRef}
            className={`live-task-history-sentinel live-task-history-sentinel-newer ${historyLoading ? 'is-loading' : ''}`}
            aria-hidden="true"
          />}
          {!itemCount && state?.status === 'ready' && <div className="pi-live-empty">{t('live.empty')}</div>}
          {syncError && <div className="pi-live-sync-warning" role="status">{t('live.syncWarning', { message: syncError })}</div>}
          {error && <div className="pi-live-error pi-live-reader-error" role="alert">{error}</div>}
          {pathError && <div className="pi-live-error pi-live-reader-error" role="alert">{pathError}</div>}
        </div>
      </div>

      <div className="pi-live-compose-wrap live-task-compose-wrap">
        <div className="pi-live-float-stack">
          {newRecords && <Button size="small" className="pi-live-new-records" onClick={jumpLatest}>{t('live.newRecords')} <UiIcon name="arrow-down" size={14}/></Button>}
          {interruptNotice && <div className="pi-live-interrupt-notice" role="status" aria-live="polite">
            <UiIcon name="check" size={14}/>
            <b>{t('live.interruptedTitle')}</b>
            <span>{t('live.interruptedDescription')}</span>
          </div>}
          {startupQueued && <div className="pi-live-startup-queue" role="status">
            <span>{t('live.startupWaitingReady')}</span>
            <b>{messageText(startupQueued)}</b>
            <div>
              <Button size="small" className="pi-live-queue-action" onClick={editStartupQueued}>{t('live.queue.edit')}</Button>
              <Button size="small" className="pi-live-queue-action" onClick={() => setStartupQueued(null)}>{t('live.queue.withdraw')}</Button>
            </div>
          </div>}
          {queueItems.length > 0 && <div className="pi-live-queue" role="status" aria-live="polite">
            {queueItems.map(item => <div key={item.id} className={`pi-live-queue-item ${item.active ? 'active' : 'restored'}`}>
              <span>{item.mode === 'steer' ? t('live.queue.steer') : t('live.queue.followUp')}</span>
              <b>{item.text}</b>
              {item.active
                ? item.pending
                  ? <small>{t('live.queue.joining')}</small>
                  : <div>
                      <small>{t('live.queue.queued')}</small>
                      {item.queueIndex !== undefined && <Button
                        size="small"
                        className="pi-live-queue-action"
                        disabled={queueMutationPending}
                        onClick={() => { void removeQueued(item.mode, item.queueIndex!, item.text) }}
                      >{t('live.queue.withdraw')}</Button>}
                    </div>
                : <div>
                    <Button size="small" className="pi-live-queue-action" onClick={() => editRestoredQueue(item)}>{t('live.queue.edit')}</Button>
                    <Button size="small" className="pi-live-queue-action" onClick={() => removeRestoredQueue(item.id)}>{t('live.queue.withdraw')}</Button>
                  </div>}
            </div>)}
          </div>}
          {extension && <LiveExtensionPrompt request={extension} pending={extensionPending} onAnswer={value => { void answerExtension(value) }}/>}
        </div>
        <div className={`pi-live-composer ${composerExpanded ? 'is-expanded' : ''}`}>
          <div className="pi-live-editor">
            <div className="pi-live-editor-toolbar" aria-label={t('live.composerToolbarAria')}>
              <IconButton
                className="pi-live-editor-action"
                title={composerExpanded ? t('live.composerShrink') : t('live.composerExpand')}
                aria-label={composerExpanded ? t('live.composerShrink') : t('live.composerExpand')}
                onClick={() => setComposerExpanded(value => !value)}
              >
                <UiIcon name={composerExpanded ? 'collapse' : 'expand'} size={16}/>
              </IconButton>
            </div>
            <LiveMarkdownComposer
              ref={composerRef}
              draft={draft}
              draftKey={composerDraftKey || undefined}
              inputHistory={inputHistory}
              commands={commands}
              workspaceReferenceSearch={product?.capabilities.includes('workspace-file-reference')
                ? searchWorkspaceReferences
                : undefined}
              onDraftPresenceChange={setComposerHasContent}
              canSubmit={canSubmit}
              onSubmit={(message, mode) => { void send(message, mode === 'followUp' ? 'follow-up' : undefined) }}
              onEscape={canInterrupt ? () => { void interrupt() } : undefined}
              placeholder={t('live.composerPlaceholder')}
              ariaLabel={t('live.composerAria')}
              inputClassName="pi-live-input"
              onAttachmentPendingChange={setComposerAttachmentPending}
              onAttachmentError={reason => setError(reason instanceof Error ? reason.message : String(reason))}
              disabled={state?.status === 'terminating' || state?.status === 'terminated'}
            />
          </div>
          <div className="pi-live-compose-bar">
            <span
              className={`pi-live-compose-runtime ${streamSupported && !connected ? 'pi-live-disconnected' : ''}`.trim()}
              title={connectionLabel}
            >
              <span className="pi-live-idle-dot" aria-hidden="true"/>
              {connectionLabel}
            </span>
            <div className="pi-live-compose-settings">
              {modelControl && <ComposerPillSelect
                ariaLabel={t('live.model')}
                title={t('live.model')}
                value={modelControl.value ?? ''}
                placeholder={modelControl.label || t('live.model')}
                disabled={busy || state?.status !== 'ready'}
                options={modelControl.options.map(option => ({
                  value: option.value,
                  label: option.label || option.value,
                  ...(option.description ? { description: option.description } : {}),
                }))}
                onChange={value => { void changeModel(value) }}
              />}
              {thinking && <ComposerPillSelect
                ariaLabel={t('live.thinking')}
                title={thinking.options.length <= 1 ? t('live.thinkingNoAlternatives') : t('live.thinking')}
                value={thinking.value}
                placeholder={thinking.label || thinking.value}
                disabled={busy || state?.status !== 'ready' || thinking.options.length <= 1}
                options={thinking.options.map(option => ({
                  value: option.value,
                  label: option.label || option.value,
                  ...(option.description ? { description: option.description } : {}),
                }))}
                onChange={value => { void changeThinking(value) }}
              />}
            </div>
            {product?.capabilities.includes('steer') && product.capabilities.includes('queue') && <div className="pi-live-compose-mode" aria-label={t('live.streamingMode')}>
              <Button size="small" className={`pi-live-mode-action ${streamingBehavior === 'steer' ? 'active' : ''}`} aria-pressed={streamingBehavior === 'steer'} onClick={() => setStreamingBehavior('steer')}>{t('live.steer')}</Button>
              <Button size="small" className={`pi-live-mode-action ${streamingBehavior === 'follow-up' ? 'active' : ''}`} aria-pressed={streamingBehavior === 'follow-up'} onClick={() => setStreamingBehavior('follow-up')}>{t('live.followUp')}</Button>
            </div>}
            <IconButton
              variant="primary"
              className="pi-live-send"
              disabled={!canSubmit || !composerHasContent}
              onClick={submitMessage}
              aria-label={t('live.send')}
            ><UiIcon name="send" size={20}/></IconButton>
          </div>
        </div>
      </div>
    </TaskSurface>
  </main>
}
