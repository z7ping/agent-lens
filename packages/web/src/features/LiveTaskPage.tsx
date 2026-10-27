import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { LiveMessageDto, LiveRuntimeStateDto, TaskFileChangesResponseDto } from '@agent-lens/protocol'
import { AgentLensApi } from '../client/api'
import { liveApi } from '../client/live'
import { LocalPathActions } from '../components/LocalPathActions'
import { contributionText, LiveRuntimeActions, LiveRuntimeDisclosures } from '../components/LiveRuntimeDisclosures'
import { TaskSessionComposer } from '../components/TaskSessionComposer'
import { liveComposerDraftKey, readLiveComposerDraft } from '../components/live-composer-session-state'
import { ErrorStateBanner, OperationProgress } from '../components/StateViews'
import { Button, IconButton, Popover } from '../components/ui'
import { LiveExtensionPrompt } from './LiveExtensionPrompt'
import { useLiveTaskState } from './live-task-state'
import { useLiveTaskRuntime } from './use-live-task-runtime'
import { useLiveTaskHistory } from './use-live-task-history'
import { useLiveTaskActions } from './use-live-task-actions'
import { type LiveQueueListItem } from './live-task-queue'
import { messageText, resolveLiveSlash } from './live-task-input'
import { scrollReaderToLastUserTurn } from './session-reader-positioning'
import { LIVE_TASK_SNAPSHOT_PAGE_LIMIT, historyPageBlock, aggregateHistoryPage, splitLiveProjectionItems } from './live-task-history-window'
import { GenericLiveRound, StableLiveRounds, liveRoundOwnsAnswerActions } from './LiveTaskTimeline'
import { UiIcon } from '../components/UiIcon'
import { AgentLogo } from '../components/AgentLogo'
import { liveTaskResponseActivity, projectLiveInputHistory, projectLiveSnapshotEntries } from './live-task-projection'
import { coalesceLiveSemanticSegments } from './live-semantic-rounds'
import { parseTaskLiveRuntimeLocation, shouldWarnLiveNoProgress, taskLiveRuntimeStatus } from './task-live-runtime'
import { TaskHeader } from './TaskHeader'
import { TaskFileChangesDisclosure, summarizeTaskFileChanges } from './TaskFileChangesDisclosure'
import { TaskSurface, type TaskTurnRailData } from './TaskSurface'
import { readableTaskHeaderTitle, taskPreciseDurationLabel, workspaceDisplayName } from './task-detail-model'

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
  const [fileChanges, setFileChanges] = useState<{ runtimeId: string; result: TaskFileChangesResponseDto | null } | null>(null)
  const [fileChangesFailure, setFileChangesFailure] = useState(false)
  const [progressClockMs, setProgressClockMs] = useState(() => Date.now())
  const [reconnectEpoch, setReconnectEpoch] = useState(0)
  const [modelMenuOpenRequest, setModelMenuOpenRequest] = useState(0)
  const [defaultModelSaving, setDefaultModelSaving] = useState(false)
  const [connectionBusy, setConnectionBusy] = useState(false)
  const [queueExpanded, setQueueExpanded] = useState(false)
  const [queueMenuOpen, setQueueMenuOpen] = useState(false)
  const queueMenuAnchorRef = useRef<HTMLSpanElement>(null)
  const current = useMemo(() => parseTaskLiveRuntimeLocation(location.pathname), [location.pathname])
  useEffect(() => {
    setQueueExpanded(false)
    setQueueMenuOpen(false)
  }, [current?.liveId, current?.runtimeSessionId])
  // Keep the reader's disclosure intent through live snapshot reconciliation.
  const processExpansionStore = useMemo(() => new Map<string, boolean>(), [current?.liveId, current?.runtimeSessionId])
  const composerDraftKey = useMemo(
    () => current ? liveComposerDraftKey(current.liveId, current.runtimeSessionId) : '',
    [current?.liveId, current?.runtimeSessionId],
  )
  const session = useLiveTaskState()
  const {
    product,
    state,
    setState,
    projection,
    setProjection,
    historyPage,
    setHistoryPage,
    historyIndex,
    historyLoading,
    setHistoryLoading,
    setHistoryPagingArmed,
    setHistoryPagingDirection,
    messageActions,
    messageActionPending,
    runtimeDisclosures,
    runtimeActionPending,
    commands,
    modelControl,
    setModelControl,
    thinking,
    extension,
    extensionPending,
    streamingBehavior,
    setStreamingBehavior,
    queue,
    pendingQueue,
    restoredQueue,
    queueMutationPending,
    connected,
    activityStatus,
    syncError,
    setSyncError,
    newRecords,
    setNewRecords,
    composerExpanded,
    setComposerExpanded,
    startupQueued,
    setStartupQueued,
    interruptNotice,
    busy,
    error,
    setError,
    pathError,
    setPathError,
    composerHasContent,
    setComposerHasContent,
    setComposerAttachmentPending,
    inputHistory,
    setInputHistory,
    draft,
    setDraft,
    composerRef,
    readerRef,
    historyLoadSentinelRef,
    historyNewerSentinelRef,
    historyAtLatestRef,
    historyBlocksRef,
    followControllerRef,
    leafIdRef,
    snapshotBaseActiveCountRef,
    roundProjectorRef,
    lastProgressAtRef,
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

  const { syncCurrentSession } = useLiveTaskRuntime({ current, t, session, reconnectEpoch })
  const synchronizeSession = useCallback(async () => {
    if (connectionBusy) return
    setConnectionBusy(true)
    try {
      await syncCurrentSession()
    } catch (reason) {
      setSyncError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setConnectionBusy(false)
    }
  }, [connectionBusy, syncCurrentSession, setSyncError])
  const reconnectSession = useCallback(() => {
    if (connectionBusy) return
    setReconnectEpoch(value => value + 1)
  }, [connectionBusy])

  const { markReaderUserIntent, onReaderScroll, jumpEarliest, jumpLatest } = useLiveTaskHistory({ current, session })

  // Explicit submission resumes follow, while subsequent manual upward scrolling still detaches it.
  const onSendAccepted = useCallback(() => {
    followControllerRef.current.restore()
    setNewRecords(false)
    if (!historyAtLatestRef.current) return
    window.requestAnimationFrame(() => {
      const reader = readerRef.current
      const controller = followControllerRef.current
      if (!reader || !controller.isFollowing) return
      controller.beginProgrammaticScroll()
      controller.recordScrollWrite()
      // After an ordinary send, prefer the newly mounted user turn to a blind
      // scrollHeight write. Streaming continues through LiveFollowController.
      if (!state?.isStreaming && !scrollReaderToLastUserTurn(reader)) {
        reader.scrollTop = Math.max(0, reader.scrollHeight - reader.clientHeight)
      } else if (state?.isStreaming) {
        reader.scrollTop = Math.max(0, reader.scrollHeight - reader.clientHeight)
      }
      window.requestAnimationFrame(() => controller.endProgrammaticScroll())
    })
  }, [followControllerRef, historyAtLatestRef, readerRef, setNewRecords, state?.isStreaming])

  // If the reader is looking at an older history window, reload latest *after* the send commits.
  // Doing so earlier could replace the optimistic user message with a stale snapshot.
  const onSendDelivered = useCallback(() => {
    if (!historyAtLatestRef.current && followControllerRef.current.isFollowing) {
      void jumpLatest()
      return
    }
    if (!state?.isStreaming) {
      window.requestAnimationFrame(() => {
        const reader = readerRef.current
        const controller = followControllerRef.current
        if (!reader || !controller.isFollowing) return
        controller.beginProgrammaticScroll()
        if (scrollReaderToLastUserTurn(reader)) controller.recordScrollWrite()
        window.requestAnimationFrame(() => controller.endProgrammaticScroll())
      })
    }
  }, [followControllerRef, historyAtLatestRef, jumpLatest, readerRef, state?.isStreaming])

  const { canSubmit, canInterrupt, sendFeedback, send, editStartupQueued, interrupt, removeQueued, editQueued, clearQueued, editRestoredQueue, removeRestoredQueue, terminate, changeModel, answerExtension, searchWorkspaceReferences, runMessageAction, runRuntimeAction, changeThinking } = useLiveTaskActions({ current, t, navigate, setComposerValue, clearComposer, session, onSendAccepted, onSendDelivered })

  useEffect(() => {
    if (!canInterrupt) return
    const onPageEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229
        || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return
      // Open overlays and the Lexical editor own Escape before the page.
      if (document.querySelector('.ui-popover, .select-menu-popover, [role="dialog"], [role="listbox"], [role="menu"]')) return
      const target = event.target
      if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return
      event.preventDefault()
      void interrupt()
    }
    document.addEventListener('keydown', onPageEscape)
    return () => document.removeEventListener('keydown', onPageEscape)
  }, [canInterrupt, interrupt])

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

  useEffect(() => {
    if (!state?.isStreaming) return
    setProgressClockMs(Date.now())
    const timer = window.setInterval(() => setProgressClockMs(Date.now()), 5_000)
    return () => window.clearInterval(timer)
  }, [state?.isStreaming, current?.runtimeSessionId])

  const noProgressWarning = shouldWarnLiveNoProgress(progressClockMs, lastProgressAtRef.current, state?.isStreaming ?? false)
  const responseActivity = liveTaskResponseActivity(projection.active, state?.isStreaming ?? false)

  const roundSegments = useMemo(
    () => coalesceLiveSemanticSegments(roundProjectorRef.current.projectSegmented(projection.stable, projection.active)),
    [projection.stable, projection.active],
  )
  const fileChangeRuntimeId = current?.runtimeSessionId
  useEffect(() => {
    setFileChanges(null)
    setFileChangesFailure(false)
  }, [fileChangeRuntimeId])
  // File change projection commits independently from Live transcript SSE.
  // Coalesce rapid events; never refetch on every streamed token.
  useEffect(() => {
    if (!fileChangeRuntimeId) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void hostApi.runtimeFileChanges(fileChangeRuntimeId, controller.signal)
        .then(value => {
          if (!controller.signal.aborted) {
            setFileChanges({ runtimeId: fileChangeRuntimeId, result: value })
            setFileChangesFailure(false)
          }
        })
        .catch(() => { if (!controller.signal.aborted) setFileChangesFailure(true) })
    }, 280)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [fileChangeRuntimeId, projection.stable.length, projection.active.length, state?.isStreaming, hostApi])

  // When a tool changes its result without adding a new timeline item, the
  // regular snapshot count stays stable. A bounded poll keeps Live changes fresh.
  useEffect(() => {
    if (!fileChangeRuntimeId || !state?.isStreaming) return
    let active = true
    const timer = window.setInterval(() => {
      void hostApi.runtimeFileChanges(fileChangeRuntimeId)
        .then(result => {
          if (active) {
            setFileChanges({ runtimeId: fileChangeRuntimeId, result })
            setFileChangesFailure(false)
          }
        })
        .catch(() => { if (active) setFileChangesFailure(true) })
    }, 4_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [fileChangeRuntimeId, state?.isStreaming, hostApi])

  // Keep recent settled text mounted while the active turn grows; bounded (two rounds).
  const stableEagerTailCount = 2
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
    const loaded = segments.map(round => {
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
    // Show global navigation as soon as native index metadata arrives. Unloaded
    // rounds are lightweight entries, not a request to hydrate their bodies.
    const byOrdinal = new Map(loaded
      .filter(item => item.ordinal)
      .map(item => [item.ordinal!, item] as const))
    for (const indexed of historyIndex?.items ?? []) {
      if (byOrdinal.has(indexed.ordinal)) continue
      byOrdinal.set(indexed.ordinal, {
        id: `indexed-round:${indexed.ordinal}`,
        cursor: indexed.cursor,
        ordinal: indexed.ordinal,
        label: t('surface.roundOrdinal', { count: indexed.ordinal }),
        preview: indexed.preview ?? '',
        error: (indexed.summary?.process.errorCount ?? 0) > 0,
        state: 'settled',
        loaded: false,
      })
    }
    return [...byOrdinal.values(), ...loaded.filter(item => !item.ordinal)]
      .sort((a, b) => (a.ordinal ?? Number.MAX_SAFE_INTEGER)
        - (b.ordinal ?? Number.MAX_SAFE_INTEGER))
  }, [historyIndex?.items, historyPage?.rounds?.firstOrdinal, roundSegments, t])
  const loadedRoundMax = turnRailItems.reduce((max, item) => Math.max(max, item.ordinal ?? 0), 0)
  const turnRailTotal = Math.max(
    historyPage?.rounds?.total ?? 0,
    historyIndex?.total ?? 0,
    loadedRoundMax,
  ) || undefined
  const itemCount = projection.stable.length + projection.active.length

  if (!current) {
    return <main className="live-task-page-embedded">
      <div className="live-task-error" role="alert">{error || t('live.invalidRuntime')}</div>
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
  const composerSessionActions = runtimeDisclosures.flatMap(disclosure =>
    (disclosure.actions ?? [])
      .filter(action => action.placement === 'composer')
      .map(action => ({
        id: action.actionId,
        label: contributionText(action.label, i18n.resolvedLanguage ?? i18n.language),
        ...(action.icon ? { icon: action.icon } : {}),
        ...(action.description ? { description: contributionText(action.description, i18n.resolvedLanguage ?? i18n.language) } : {}),
        disabled: runtimeActionPending !== null || state?.status !== 'ready' || state.isStreaming,
        onClick: () => { void runRuntimeAction(action) },
      })),
  )
  // Runtime-advertised actions are never delivered to the language model as text.
  // Pi extension/template/skill commands without an action remain native SDK prompts.
  const submitLiveMessage = (message: LiveMessageDto, behavior?: 'follow-up') => {
    const result = resolveLiveSlash(message, commands)
    if (result.kind === 'blocked') {
      setError(t('live.slashCommandBlocked', { name: result.name }))
      return
    }
    if (result.kind === 'action') {
      const command = result.command
      if (command.action === 'new-task') {
        clearComposer()
        navigate('/review/new')
      } else if (command.action === 'resume-task') {
        clearComposer()
        navigate('/review')
      } else if (command.action === 'open-model') {
        if (!modelControl) { setError(t('live.modelSelectorUnavailable')); return }
        clearComposer()
        setModelMenuOpenRequest(value => value + 1)
      } else if (command.action === 'runtime-action') {
        const action = runtimeDisclosures.flatMap(item => item.actions ?? [])
          .find(item => item.actionId === command.runtimeActionId)
        if (!action || state?.status !== 'ready' || state.isStreaming) {
          setError(t('live.commandUnavailable'))
          return
        }
        clearComposer()
        void runRuntimeAction(action)
      }
      return
    }
    void send(message, behavior)
  }
  const interruptAvailable = Boolean(state?.isStreaming && product?.capabilities.includes('interrupt'))
  const interruptBusy = busy || queueMutationPending
  const submitMessage = () => {
    const message = composerRef.current?.getMessage()
    if (message) submitLiveMessage(message)
  }
  const setGlobalDefaultModel = async () => {
    if (!current || !modelControl?.value || defaultModelSaving) return
    setDefaultModelSaving(true)
    setError('')
    try {
      const updated = await liveApi.setDefaultModelControl(current.liveId, current.runtimeSessionId, modelControl.value)
      if (!updated || updated.defaultValue !== modelControl.value) throw new Error(t('live.defaultModelNotSaved'))
      setModelControl(updated)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setDefaultModelSaving(false)
    }
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

  const queueCanMutate = Boolean(product?.capabilities.includes('queue-mutation'))
  const queueCount = queueItems.length + Number(Boolean(startupQueued))
  const queuePreview = startupQueued ? messageText(startupQueued) : queueItems[0]?.text ?? ''
  const queueContent = queueCount > 0 ? <div className="live-task-queue" role="region" aria-label={t('live.queue.title')}>
    <div className="live-task-queue-header">
      <Button
        variant="quiet"
        className="live-task-queue-toggle"
        aria-expanded={queueExpanded}
        onClick={() => setQueueExpanded(value => !value)}
      >
        <UiIcon name="task" size={14}/>
        <strong>{t('live.queue.count', { count: queueCount })}</strong>
        <span className="live-task-queue-preview" title={queuePreview}>{queuePreview}</span>
        <UiIcon name={queueExpanded ? 'sort-up' : 'sort-down'} size={12}/>
      </Button>
      <span ref={queueMenuAnchorRef} className="live-task-queue-menu-anchor">
        <IconButton
          size="small"
          aria-label={t('live.queue.menu')}
          aria-haspopup="menu"
          aria-expanded={queueMenuOpen}
          onClick={() => setQueueMenuOpen(value => !value)}
        ><UiIcon name="more" size={16}/></IconButton>
        <Popover open={queueMenuOpen} anchorRef={queueMenuAnchorRef} onClose={() => setQueueMenuOpen(false)} className="task-composer-menu-popover">
          <div className="task-composer-menu-list" role="menu" aria-label={t('live.queue.menu')}>
            <Button size="small" variant="quiet" role="menuitem"
              disabled={queueMutationPending || busy || pendingQueue.length > 0}
              onClick={() => { setQueueMenuOpen(false); void clearQueued() }}
            ><UiIcon name="close" size={16}/>{t('live.queue.clear')}</Button>
          </div>
        </Popover>
      </span>
    </div>
    {queueExpanded && <div className="live-task-queue-list">
      {startupQueued && <div className="live-task-queue-item">
        <span className="live-task-queue-type">{t('live.queue.waitingReady')}</span>
        <b title={messageText(startupQueued)}>{messageText(startupQueued)}</b>
        <span className="live-task-queue-actions">
          <IconButton size="small" aria-label={t('live.queue.edit')} title={composerHasContent ? t('live.queue.draftPending') : t('live.queue.edit')} disabled={queueMutationPending || composerHasContent} onClick={editStartupQueued}><UiIcon name="tool-edit" size={14}/></IconButton>
          <IconButton size="small" aria-label={t('live.queue.withdraw')} disabled={queueMutationPending} onClick={() => setStartupQueued(null)}><UiIcon name="close" size={14}/></IconButton>
        </span>
      </div>}
      {queueItems.map(item => <div key={item.id} className="live-task-queue-item">
        <span className="live-task-queue-type">{item.pending ? t('live.queue.joining') : !item.active ? t('live.queue.restored') : item.mode === 'steer' ? t('live.queue.steer') : t('live.queue.followUp')}</span>
        <b title={item.text}>{item.text}</b>
        <span className="live-task-queue-actions">
          {!item.pending && (!item.active || queueCanMutate) && <IconButton size="small" aria-label={t('live.queue.edit')} title={composerHasContent ? t('live.queue.draftPending') : t('live.queue.edit')} disabled={queueMutationPending || busy || composerHasContent}
            onClick={() => { if (item.active && item.queueIndex !== undefined) void editQueued(item.mode, item.queueIndex, item.text); else if (!item.active) editRestoredQueue(item) }}
          ><UiIcon name="tool-edit" size={14}/></IconButton>}
          {!item.pending && (!item.active || queueCanMutate) && <IconButton size="small" aria-label={t('live.queue.withdraw')} disabled={queueMutationPending || busy}
            onClick={() => { if (item.active && item.queueIndex !== undefined) void removeQueued(item.mode, item.queueIndex, item.text); else if (!item.active) removeRestoredQueue(item.id) }}
          ><UiIcon name="close" size={14}/></IconButton>}
        </span>
      </div>)}
    </div>}
  </div> : undefined

  return <main className={`live-task-page ${embedded ? 'live-task-page-embedded' : ''}`}>
    <TaskSurface
      mode="live"
      className="live-task-workspace"
      boundaryNavigation={{
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
        title={readableTaskHeaderTitle(title)}
        metrics={[]}
        infoPanel={fileChanges !== null && fileChanges.runtimeId === fileChangeRuntimeId
          && fileChanges.result
          && (fileChanges.result.summary.count > 0 || fileChanges.result.meta.truncated)
          ? {
              label: summarizeTaskFileChanges(fileChanges.result).observed
                ? t('review:local.fileChanges.activityCount', { count: fileChanges.result.summary.count })
                : t('review:local.fileChanges.titleCount', { count: fileChanges.result.summary.count }),
              summary: summarizeTaskFileChanges(fileChanges.result).observed
                ? t('review:local.fileChanges.activityCount', { count: fileChanges.result.summary.count })
                : t('review:local.fileChanges.titleCount', { count: fileChanges.result.summary.count }),
              fileSummary: summarizeTaskFileChanges(fileChanges.result),
              content: <TaskFileChangesDisclosure value={fileChanges.result} error={fileChangesFailure ? 'failed' : ''} inlineDetails/>,
            } : fileChangeRuntimeId ? {
              label: t('review:local.fileChanges.title'),
              summary: t('review:local.fileChanges.title'),
              content: <TaskFileChangesDisclosure
                value={fileChanges?.runtimeId === fileChangeRuntimeId ? fileChanges.result : null}
                loading={fileChanges?.runtimeId !== fileChangeRuntimeId && !fileChangesFailure}
                error={fileChangesFailure ? 'failed' : ''}
                inlineDetails
              />,
            } : undefined}
        infoItems={[
          { label: t('header.context'), value: workspace || t('header.unlinkedProject') },
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
        className="live-task-reader"
        onScroll={onReaderScroll}
        onWheel={event => markReaderUserIntent(event.deltaY < 0 ? 'older' : 'newer')}
        onTouchStart={() => markReaderUserIntent()}
        onPointerDown={() => markReaderUserIntent()}
      >
        <div className="live-task-document">
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
          {runtimeDisclosures.every(item => !item.lifecycle) && (!state || state.status === 'initializing') && !error && <div className="live-task-startup-spotlight">
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
            processExpansionStore={processExpansionStore}
            onMessageAction={runMessageAction}
          />
          {noProgressWarning && <div className="live-task-sync-warning" role="status">
            <UiIcon name="alert" size={14}/>
            {t('live.noProgressWarning', { duration: taskPreciseDurationLabel(progressClockMs - lastProgressAtRef.current) })}
          </div>}
          {roundSegments.active.map((round, index) => <GenericLiveRound
            key={round.model.id}
            projection={round}
            agentLabel={agentLabel}
            eager={round.model.state === 'running' || index >= roundSegments.active.length - 2}
            showAnswerActions={liveRoundOwnsAnswerActions(roundSegments.active, index)}
            messageActions={messageActions}
            actionPending={messageActionPending}
            runtimeStreaming={state?.isStreaming ?? false}
            showResponsePending={Boolean(state?.isStreaming) && index === roundSegments.active.length - 1}
            processExpansionStore={processExpansionStore}
            onMessageAction={runMessageAction}
          />)}
          {historyPage?.hasLater && <div
            ref={historyNewerSentinelRef}
            className={`live-task-history-sentinel live-task-history-sentinel-newer ${historyLoading ? 'is-loading' : ''}`}
            aria-hidden="true"
          />}
          {!itemCount && state?.status === 'ready' && <div className="live-task-empty">{t('live.empty')}</div>}
          {syncError && <div className="live-task-sync-warning" role="status">{t('live.syncWarning', { message: syncError })}</div>}
          {error && state?.status !== 'failed' && <div className="live-task-error live-task-reader-error" role="alert">{error}</div>}
          {pathError && <div className="live-task-error live-task-reader-error" role="alert">{pathError}</div>}
        </div>
      </div>

      <div className="task-session-composer-slot">
        {state?.status === 'failed' && <ErrorStateBanner
          title={t('center.runtimeStatus.failed')}
          message={error || runtimeDisclosures.flatMap(item => item.lifecycle?.status === 'failed' && item.lifecycle.message
            ? [contributionText(item.lifecycle.message, i18n.resolvedLanguage ?? i18n.language)] : []).join('\n') || t('center.runtimeStatus.failed')}
          showDoctor={false}
          actions={runtimeDisclosures.map(item => <LiveRuntimeActions
            key={item.contributionId}
            item={item}
            language={i18n.resolvedLanguage ?? i18n.language}
            pendingAction={runtimeActionPending}
            onAction={action => { void runRuntimeAction(action) }}
          />)}
        />}
        <div className="live-task-float-stack">
          {newRecords && <Button size="small" className="live-task-new-records" onClick={jumpLatest}>{t('live.newRecords')} <UiIcon name="arrow-down" size={14}/></Button>}
          {interruptNotice && <div className="live-task-interrupt-notice" role="status" aria-live="polite">
            <UiIcon name="check" size={14}/>
            <b>{t('live.interruptedTitle')}</b>
            <span>{t('live.interruptedDescription')}</span>
          </div>}
          {extension && <LiveExtensionPrompt request={extension} pending={extensionPending} onAnswer={value => { void answerExtension(value) }}/>}
        </div>
        <TaskSessionComposer
          queueContent={queueContent}
          editorRef={composerRef}
          expanded={composerExpanded}
          onExpandedChange={setComposerExpanded}
          draft={draft}
          draftKey={composerDraftKey || undefined}
          inputHistory={inputHistory}
          commands={commands}
          workspaceReferenceSearch={product?.capabilities.includes('workspace-file-reference')
            ? searchWorkspaceReferences
            : undefined}
          onDraftPresenceChange={setComposerHasContent}
          canSubmit={canSubmit}
          interruptAvailable={interruptAvailable}
          interruptBusy={interruptBusy}
          onInterrupt={() => { void interrupt() }}
          responseActivity={responseActivity}
          sendFeedback={sendFeedback}
          runtimeMetrics={{ contextUsage: state?.contextUsage, cacheMetrics: state?.cacheMetrics }}
          onSubmit={(message, mode) => submitLiveMessage(message, mode === 'followUp' ? 'follow-up' : undefined)}
          onEscape={canInterrupt ? () => { void interrupt() } : undefined}
          placeholder={t('live.composerPlaceholder')}
          ariaLabel={t('live.composerAria')}
          onAttachmentPendingChange={setComposerAttachmentPending}
          onAttachmentError={reason => setError(reason instanceof Error ? reason.message : String(reason))}
          disabled={state?.status === 'terminating' || state?.status === 'terminated'}
          connectionLabel={connectionLabel}
          disconnected={streamSupported && !connected}
          {...(streamSupported && product?.capabilities.includes('recovery') ? { onSyncSession: synchronizeSession } : {})}
          {...(streamSupported && (state?.status === 'ready' || state?.status === 'initializing') ? { onReconnectSession: reconnectSession } : {})}
          connectionBusy={connectionBusy}
          sessionActions={composerSessionActions}
          modelControl={modelControl}
          thinking={thinking}
          controlsBusy={busy || defaultModelSaving}
          controlsReady={state?.status === 'ready'}
          onModelChange={value => { void changeModel(value) }}
          modelMenuOpenRequest={modelMenuOpenRequest}
          {...(product?.capabilities.includes('model-default') ? { onSetDefaultModel: () => { void setGlobalDefaultModel() } } : {})}
          onThinkingChange={value => { void changeThinking(value) }}
          showStreamingModes={Boolean(product?.capabilities.includes('steer') && product.capabilities.includes('queue'))}
          streamingMode={streamingBehavior}
          onStreamingModeChange={setStreamingBehavior}
          hasContent={composerHasContent}
          onSendClick={submitMessage}
        />
      </div>
    </TaskSurface>
  </main>
}
