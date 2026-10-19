import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { LiveRuntimeStateDto, TaskFileChangesResponseDto } from '@agent-lens/protocol'
import { AgentLensApi } from '../client/api'
import { liveApi } from '../client/live'
import { ComposerPillSelect } from '../components/ComposerPillSelect'
import { LocalPathActions } from '../components/LocalPathActions'
import { LiveRuntimeDisclosures } from '../components/LiveRuntimeDisclosures'
import { LiveMarkdownComposer } from '../components/LiveMarkdownComposer'
import { liveComposerDraftKey, readLiveComposerDraft } from '../components/live-composer-session-state'
import { OperationProgress } from '../components/StateViews'
import { Button, IconButton } from '../components/ui'
import { LiveExtensionPrompt } from './LiveExtensionPrompt'
import { useLiveTaskState } from './live-task-state'
import { useLiveTaskRuntime } from './use-live-task-runtime'
import { useLiveTaskHistory } from './use-live-task-history'
import { useLiveTaskActions } from './use-live-task-actions'
import { type LiveQueueListItem } from './live-task-queue'
import { messageText } from './live-task-input'
import { LIVE_TASK_SNAPSHOT_PAGE_LIMIT, historyPageBlock, aggregateHistoryPage, splitLiveProjectionItems } from './live-task-history-window'
import { GenericLiveRound, StableLiveRounds, liveRoundOwnsAnswerActions } from './LiveTaskTimeline'
import { UiIcon } from '../components/UiIcon'
import { AgentLogo } from '../components/AgentLogo'
import { projectLiveInputHistory, projectLiveSnapshotEntries } from './live-task-projection'
import { coalesceLiveSemanticSegments } from './live-semantic-rounds'
import { parseTaskLiveRuntimeLocation, taskLiveRuntimeStatus } from './task-live-runtime'
import { TaskHeader } from './TaskHeader'
import { TaskFileChangesDisclosure } from './TaskFileChangesDisclosure'
import { TaskSurface, type TaskTurnRailData } from './TaskSurface'
import { readableTaskHeaderTitle, workspaceDisplayName } from './task-detail-model'

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
  const current = useMemo(() => parseTaskLiveRuntimeLocation(location.pathname), [location.pathname])
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
    roundProjectorRef
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

  const { markReaderUserIntent, onReaderScroll, jumpEarliest, jumpLatest } = useLiveTaskHistory({ current, session })

  const { canSubmit, canInterrupt, send, editStartupQueued, interrupt, removeQueued, editRestoredQueue, removeRestoredQueue, terminate, changeModel, answerExtension, searchWorkspaceReferences, runMessageAction, runRuntimeAction, changeThinking } = useLiveTaskActions({ current, t, navigate, setComposerValue, clearComposer, session })

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
    () => coalesceLiveSemanticSegments(roundProjectorRef.current.projectSegmented(projection.stable, projection.active)),
    [projection.stable, projection.active],
  )
  const fileChangeRuntimeId = current?.runtimeSessionId
  // File change projection commits independently from Live transcript SSE.
  // Coalesce rapid events; never refetch on every streamed token.
  useEffect(() => {
    if (!fileChangeRuntimeId) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void hostApi.runtimeFileChanges(fileChangeRuntimeId, controller.signal)
        .then(value => { if (!controller.signal.aborted) setFileChanges({ runtimeId: fileChangeRuntimeId, result: value }) })
        .catch(() => undefined)
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
        .then(result => { if (active) setFileChanges({ runtimeId: fileChangeRuntimeId, result }) })
        .catch(() => undefined)
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
        title={readableTaskHeaderTitle(title)}
        metrics={[]}
        infoPanel={fileChanges?.runtimeId === fileChangeRuntimeId
          && fileChanges.result
          && (fileChanges.result.summary.count > 0 || fileChanges.result.meta.truncated)
          ? {
              label: t('review:local.fileChanges.titleCount', { count: fileChanges.result.summary.count }),
              summary: t('review:local.fileChanges.titleCount', { count: fileChanges.result.summary.count }),
              content: <TaskFileChangesDisclosure value={fileChanges.result} inlineDetails/>,
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
            showAnswerActions={liveRoundOwnsAnswerActions(roundSegments.active, index)}
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
                control="model"
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
                control="thinking"
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
