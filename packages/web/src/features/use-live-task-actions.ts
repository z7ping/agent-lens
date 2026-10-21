import type { useTranslation } from 'react-i18next'
import type { useNavigate } from 'react-router-dom'
import type { TaskLiveRuntimeLocation } from './task-live-runtime'
import type { LiveTaskState } from './live-task-state'
import { useCallback, useEffect } from 'react'
import type { LiveMessageActionContributionDto, LiveMessageDto, LiveRuntimeActionContributionDto } from '@agent-lens/protocol'
import { liveApi } from '../client/live'
import { liveComposerDraftKey, writeLiveComposerDraft } from '../components/live-composer-session-state'
import { emptyLiveQueue, restoredQueueDrafts, queueTextMessage, type LiveQueueMode, type RestoredQueueDraft } from './live-task-queue'
import { messageText, messageHasAttachments, optimisticMessageAttachments, unsupportedInput } from './live-task-input'
import { LIVE_TASK_SNAPSHOT_PAGE_LIMIT, historyPageBlock, aggregateHistoryPage, splitLiveProjectionItems } from './live-task-history-window'
import { appendLiveInputHistory, appendOptimisticLiveUserMessage, projectLiveInputHistory, projectLiveSnapshotEntries, settleLiveTaskProjectionItems, type LiveTaskProjectionItem } from './live-task-projection'

/** 负责发送、中断、恢复草稿、队列、模型、扩展和私有动作，不渲染页面。 */
export function useLiveTaskActions({
  current, t, navigate, setComposerValue, clearComposer, session, onSendAccepted, onSendDelivered,
}: {
  current: TaskLiveRuntimeLocation | null
  t: ReturnType<typeof useTranslation>['t']
  navigate: ReturnType<typeof useNavigate>
  setComposerValue(value: string): void
  clearComposer(): void
  onSendAccepted?(): void
  onSendDelivered?(): void
  session: LiveTaskState
}) {
  const {
    product,
    state,
    setState,
    setProjection,
    setHistoryPage,
    messageActionPending,
    setMessageActionPending,
    runtimeDisclosures,
    setRuntimeDisclosures,
    runtimeActionPending,
    setRuntimeActionPending,
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
    setPendingQueue,
    restoredQueue,
    setRestoredQueue,
    queueMutationPending,
    setQueueMutationPending,
    startupQueued,
    setStartupQueued,
    setInterruptNotice,
    busy,
    setBusy,
    setError,
    composerAttachmentPending,
    setInputHistory,
    composerRef,
    historyAtLatestRef,
    historyBlocksRef,
    startupSendingRef,
    leafIdRef,
    snapshotBaseActiveCountRef,
    liveTurnRevisionRef
  } = session
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
      onSendAccepted?.()
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

    onSendAccepted?.()
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
      onSendDelivered?.()
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
  }, [canSubmit, clearComposer, current, product, state, streamingBehavior, t, onSendAccepted, onSendDelivered])

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

  const mutateQueuedEntry = useCallback(async (
    mode: LiveQueueMode, queueIndex: number, text: string, restoreDraft: boolean,
  ) => {
    if (!current || !product?.capabilities.includes('queue') || queueMutationPending) return
    const items = mode === 'steer' ? queue.steering : queue.followUp
    if (items[queueIndex] !== text) {
      setError(t('live.queue.changed'))
      return
    }
    setQueueMutationPending(true)
    setError('')
    try {
      // Never clear and rebuild the queue in the browser. The native runtime
      // validates this snapshot and applies the removal in one Worker turn.
      const next = await liveApi.mutateQueue(current.liveId, current.runtimeSessionId, {
        expected: { steering: [...queue.steering], followUp: [...queue.followUp] },
        mode, index: queueIndex,
      })
      setQueue(next)
      setState(previous => previous
        ? { ...previous, pendingMessageCount: next.steering.length + next.followUp.length }
        : previous)
      if (restoreDraft) {
        setComposerValue(text)
        setStreamingBehavior(mode)
        requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }))
      }
    } catch (reason) {
      const refreshed = await liveApi.queueState(current.liveId, current.runtimeSessionId).catch(() => null)
      if (refreshed) setQueue(refreshed)
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setQueueMutationPending(false)
    }
  }, [current, product?.capabilities, queueMutationPending, queue, setComposerValue, t])

  const removeQueued = useCallback((mode: LiveQueueMode, index: number, text: string) =>
    mutateQueuedEntry(mode, index, text, false), [mutateQueuedEntry])
  const editQueued = useCallback((mode: LiveQueueMode, index: number, text: string) =>
    mutateQueuedEntry(mode, index, text, true), [mutateQueuedEntry])

  const clearQueued = useCallback(async () => {
    if (!current || queueMutationPending || busy) return
    setQueueMutationPending(true)
    setError('')
    try {
      if (product?.capabilities.includes('queue') && (queue.steering.length || queue.followUp.length)) {
        await liveApi.clearQueue(current.liveId, current.runtimeSessionId)
      }
      setQueue(emptyLiveQueue())
      setRestoredQueue([])
      setStartupQueued(null)
      setState(previous => previous ? { ...previous, pendingMessageCount: 0 } : previous)
    } catch (reason) {
      const refreshed = await liveApi.queueState(current.liveId, current.runtimeSessionId).catch(() => null)
      if (refreshed) setQueue(refreshed)
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setQueueMutationPending(false)
    }
  }, [current, product?.capabilities, queueMutationPending, busy, queue])

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
      // A queued approval may arrive over SSE before this HTTP request completes.
      setExtension(previous => previous?.requestId === extension.requestId ? null : previous)
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


  return { canSubmit, canInterrupt, send, editStartupQueued, interrupt, removeQueued, editQueued, clearQueued, editRestoredQueue, removeRestoredQueue, terminate, changeModel, answerExtension, searchWorkspaceReferences, runMessageAction, runRuntimeAction, changeThinking }
}
