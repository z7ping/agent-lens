import type { useTranslation } from 'react-i18next'
import type { TaskLiveRuntimeLocation } from './task-live-runtime'
import type { LiveTaskState } from './live-task-state'
import { useEffect } from 'react'
import { liveApi } from '../client/live'
import { emptyLiveQueue, firstUserEntryCursor } from './live-task-queue'
import { LIVE_TASK_SNAPSHOT_PAGE_LIMIT, historyPageBlock, aggregateHistoryPage, splitLiveProjectionItems, loadBoundedRecoverySnapshot } from './live-task-history-window'
import { projectLiveInputHistory, projectLiveSnapshotEntries, liveEventChangesTaskTranscript, mergeLiveActiveProjectionItems, reduceLiveTaskEvent } from './live-task-projection'
import { LiveFollowController, liveFollowTextRevision } from './live-follow-controller'
import { shouldRecoverLiveOnVisible, sameLiveRuntimeState, runtimeStateFromEvent } from './task-live-runtime'

/** 会话初始化、SSE 对账与可见性恢复；不负责输入交互和页面渲染。 */
export function useLiveTaskRuntime({
  current,
  t,
  session,
}: {
  current: TaskLiveRuntimeLocation | null
  t: ReturnType<typeof useTranslation>['t']
  session: LiveTaskState
}) {
  const {
    product,
    setProduct,
    state,
    setState,
    projection,
    setProjection,
    setHistoryPage,
    historyIndex,
    setHistoryIndex,
    setHistoryLoading,
    setHistoryPagingArmed,
    setHistoryPagingDirection,
    messageActions,
    setMessageActions,
    setMessageActionPending,
    runtimeDisclosures,
    setRuntimeDisclosures,
    setRuntimeActionPending,
    commands,
    setCommands,
    modelControl,
    setModelControl,
    thinking,
    setThinking,
    extension,
    setExtension,
    queue,
    setQueue,
    setPendingQueue,
    setRestoredQueue,
    setQueueMutationPending,
    setConnected,
    setActivityStatus,
    bootstrapTarget,
    setBootstrapTarget,
    setSyncError,
    setNewRecords,
    setComposerExpanded,
    setStartupQueued,
    interruptNotice,
    setInterruptNotice,
    error,
    setError,
    setPathError,
    setInputHistory,
    readerRef,
    lastReaderScrollTopRef,
    historyAtLatestRef,
    historyIndexAnchorCursorRef,
    historyBlocksRef,
    runtimeStateRef,
    lastProgressAtRef,
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
  useEffect(() => {
    let cancelled = false
    setProduct(null)
    setState(null)
    lastProgressAtRef.current = Date.now()
    setProjection({ stable: [], active: [] })
    setHistoryPage(null)
    setHistoryIndex(null)
    setHistoryLoading(false)
    setHistoryPagingArmed(false)
    setHistoryPagingDirection(null)
    lastReaderScrollTopRef.current = 0
    historyAtLatestRef.current = true
    historyIndexAnchorCursorRef.current = undefined
    historyBlocksRef.current = []
    setMessageActions([])
    setMessageActionPending(null)
    setRuntimeDisclosures([])
    setRuntimeActionPending(null)
    setCommands([])
    setModelControl(null)
    setThinking(null)
    setExtension(null)
    setQueue(emptyLiveQueue())
    setPendingQueue([])
    setRestoredQueue([])
    setQueueMutationPending(false)
    queueRevisionRef.current += 1
    leafIdRef.current = undefined
    snapshotBaseActiveCountRef.current = 0
    liveTurnRevisionRef.current = 0
    roundProjectorRef.current.reset()
    setConnected(false)
    setActivityStatus(null)
    setBootstrapTarget(null)
    setSyncError('')
    setNewRecords(false)
    setComposerExpanded(false)
    setStartupQueued(null)
    setInterruptNotice(false)
    startupSendingRef.current = false
    followControllerRef.current = new LiveFollowController()
    setError('')
    setPathError('')
    setInputHistory([])

    if (!current) {
      setError(t('live.invalidRuntime'))
      return () => { cancelled = true }
    }

    // The page shell and SSE must not wait for Worker-backed Snapshot.
    // State returns the Logical Runtime immediately and may only trigger
    // background hydration; Snapshot fills the transcript independently.
    setBootstrapTarget({ liveId: current.liveId, runtimeSessionId: current.runtimeSessionId })

    const metadataRequest = liveApi.metadata(current.liveId).then(metadata => {
      if (!cancelled) setProduct(metadata)
      return metadata
    })

    const stateRequest = liveApi.state(current.liveId, current.runtimeSessionId).then(
      runtime => {
        if (!cancelled) {
          runtimeStateRef.current = runtime
          setState(runtime)
        }
        return runtime
      },
      reason => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
        throw reason
      },
    )

    // Runtime diagnostics include the current initialization stage. Fetch them
    // as soon as the logical state exists; do not queue them behind controls
    // that legitimately wait for a ready Worker.
    void stateRequest.then(() => liveApi.runtimeDisclosures(
      current.liveId,
      current.runtimeSessionId,
    )).then(
      disclosures => { if (!cancelled) setRuntimeDisclosures(disclosures) },
      () => undefined,
    )

    void liveApi.snapshot(
      current.liveId,
      current.runtimeSessionId,
      undefined,
      { limit: LIVE_TASK_SNAPSHOT_PAGE_LIMIT },
    ).then(
      snapshot => {
        if (cancelled) return
        runtimeStateRef.current = snapshot.state
        setState(snapshot.state)
        const projectedItems = projectLiveSnapshotEntries(snapshot.entries)
        const nextProjection = splitLiveProjectionItems(projectedItems, snapshot.state.isStreaming)
        historyIndexAnchorCursorRef.current = firstUserEntryCursor(projectedItems)
        setProjection(nextProjection)
        historyBlocksRef.current = [historyPageBlock(snapshot, projectedItems)]
        setHistoryPage(aggregateHistoryPage(historyBlocksRef.current))
        historyAtLatestRef.current = snapshot.page?.hasLater !== true
        setInputHistory(projectLiveInputHistory(projectedItems))
        snapshotBaseActiveCountRef.current = nextProjection.active.length
        leafIdRef.current = snapshot.leafId ?? undefined
      },
      snapshotError => {
        if (!cancelled) setSyncError(snapshotError instanceof Error ? snapshotError.message : String(snapshotError))
      },
    )

    void Promise.all([stateRequest, metadataRequest]).then(async ([, matched]) => {
      if (cancelled) return
      const queueRevision = queueRevisionRef.current

      // Supporting reads: runtime controls can fill in after the transcript is already visible.
      const [model, thinkingControl, queueState] = await Promise.all([
        matched.capabilities.includes('model-switching')
          ? liveApi.modelControl(current.liveId, current.runtimeSessionId).catch(() => {
              if (!cancelled) setSyncError(t('live.controlsSyncFailed'))
              return null
            })
          : Promise.resolve(null),
        matched.capabilities.includes('thinking-control')
          ? liveApi.thinkingControl(current.liveId, current.runtimeSessionId).catch(() => {
              if (!cancelled) setSyncError(t('live.controlsSyncFailed'))
              return null
            })
          : Promise.resolve(null),
        matched.capabilities.includes('queue')
          ? liveApi.queueState(current.liveId, current.runtimeSessionId).catch(() => null)
          : Promise.resolve(null),
      ])
      if (cancelled) return
      setModelControl(model)
      setThinking(thinkingControl)
      if (queueState && queueRevisionRef.current === queueRevision) setQueue(queueState)

      // Opportunistic reads never hold the first transcript or primary controls.
      const [messageActionOptions, runtimeDisclosureOptions, commandOptions, historyIndexValue] = await Promise.all([
        liveApi.messageActions(current.liveId, current.runtimeSessionId).catch(() => []),
        liveApi.runtimeDisclosures(current.liveId, current.runtimeSessionId).catch(() => []),
        matched.capabilities.includes('command-discovery')
          ? liveApi.commands(current.liveId, current.runtimeSessionId).catch(() => [])
          : Promise.resolve([]),
        matched.capabilities.includes('history-index')
          ? liveApi.historyIndex(
              current.liveId,
              current.runtimeSessionId,
              historyIndexAnchorCursorRef.current
                ? { cursor: historyIndexAnchorCursorRef.current }
                : { limit: 0 },
            ).catch(() => null)
          : Promise.resolve(null),
      ])
      if (cancelled) return
      setMessageActions(messageActionOptions)
      setRuntimeDisclosures(runtimeDisclosureOptions)
      setCommands(commandOptions)
      setHistoryIndex(historyIndexValue)
    }).catch(reason => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    })

    return () => { cancelled = true }
  }, [current?.liveId, current?.runtimeSessionId, t])

  useEffect(() => {
    if (!current
      || bootstrapTarget?.liveId !== current.liveId
      || bootstrapTarget.runtimeSessionId !== current.runtimeSessionId
      || !product?.capabilities.includes('stream')) return
    let recoveryGeneration = 0
    let recoveryActive = true
    let recoveryTask: Promise<void> | null = null
    let pendingRecoveryMode: 'live' | 'settle' | null = null

    const recoverOnce = async (mode: 'live' | 'settle') => {
      if (!product.capabilities.includes('recovery')) return
      if (!historyAtLatestRef.current) {
        if (mode === 'settle') setNewRecords(true)
        return
      }
      const generation = ++recoveryGeneration
      try {
        const queueRevision = queueRevisionRef.current
        const recoveryLeafId = leafIdRef.current
        const snapshotBaseActiveCount = snapshotBaseActiveCountRef.current
        const recoveryTurnRevision = liveTurnRevisionRef.current
        const [snapshot, queueState, disclosureOptions] = await Promise.all([
          loadBoundedRecoverySnapshot(current.liveId, current.runtimeSessionId, recoveryLeafId),
          product.capabilities.includes('queue')
            ? liveApi.queueState(current.liveId, current.runtimeSessionId).catch(() => null)
            : Promise.resolve(null),
          liveApi.runtimeDisclosures(current.liveId, current.runtimeSessionId).catch(() => []),
        ])
        if (!recoveryActive || generation !== recoveryGeneration) return
        if (liveTurnRevisionRef.current !== recoveryTurnRevision) return
        setState(snapshot.state)
        const recovered = projectLiveSnapshotEntries(snapshot.entries)
        if (mode === 'settle' && snapshot.state.isStreaming) {
          // A new turn started before the previous completion reconciliation returned.
          // Keep the local active tail intact and do not advance leaf; the next settled
          // recovery will reconcile every persisted entry since the original leaf.
        } else if (!recoveryLeafId) {
          const nextProjection = splitLiveProjectionItems(recovered, snapshot.state.isStreaming)
          setProjection(nextProjection)
          historyBlocksRef.current = [historyPageBlock(snapshot, recovered)]
          setHistoryPage(aggregateHistoryPage(historyBlocksRef.current))
          setInputHistory(projectLiveInputHistory(recovered))
          snapshotBaseActiveCountRef.current = nextProjection.active.length
          leafIdRef.current = snapshot.leafId ?? undefined
        } else if (snapshot.state.isStreaming) {
          // 重连中的增量快照只补当前活动轮的已持久化片段，不复制稳定历史；
          // 完成态仍从旧 leaf 对账，替换活动轮中的乐观/流式临时节点。
          setProjection(previous => ({
            ...previous,
            active: mergeLiveActiveProjectionItems(previous.active, recovered),
          }))
        } else if (recovered.length > 0) {
          setProjection(previous => {
            const reconciledActive = [
              ...previous.active.slice(0, snapshotBaseActiveCount),
              ...recovered,
            ]
            return {
              stable: [...previous.stable, ...reconciledActive],
              active: [],
            }
          })
          snapshotBaseActiveCountRef.current = 0
          leafIdRef.current = snapshot.leafId ?? recoveryLeafId
        } else {
          leafIdRef.current = snapshot.leafId ?? recoveryLeafId
        }
        setRuntimeDisclosures(disclosureOptions)
        setSyncError('')
        if (queueState && queueRevisionRef.current === queueRevision) setQueue(queueState)
      } catch (reason) {
        if (recoveryActive && generation === recoveryGeneration) {
          setSyncError(reason instanceof Error ? reason.message : String(reason))
        }
      }
    }

    const recover = (mode: 'live' | 'settle' = 'live'): Promise<void> => {
      if (!product.capabilities.includes('recovery') || !recoveryActive) return Promise.resolve()
      if (recoveryTask) {
        if (mode === 'settle' || pendingRecoveryMode === null) pendingRecoveryMode = mode
        return recoveryTask
      }

      let task: Promise<void>
      task = (async () => {
        let nextMode: 'live' | 'settle' | null = mode
        while (recoveryActive && nextMode) {
          const currentMode = nextMode
          pendingRecoveryMode = null
          await recoverOnce(currentMode)
          nextMode = pendingRecoveryMode
        }
      })().finally(() => {
        if (recoveryTask === task) recoveryTask = null
      })
      recoveryTask = task
      return task
    }

    let reconcileEpoch = 0
    let runtimeActive = false
    let runtimeCompacting = false
    let hiddenSince: number | null = document.visibilityState === 'hidden' ? Date.now() : null
    let streamDisconnected = false
    const reconcileState = async (forceRecovery = false) => {
      const epoch = ++reconcileEpoch
      try {
        const runtime = await liveApi.state(current.liveId, current.runtimeSessionId)
        if (!recoveryActive || epoch !== reconcileEpoch) return
        const previous = runtimeStateRef.current
        const changed = previous?.status !== runtime.status
          || previous?.isStreaming !== runtime.isStreaming
          || previous?.pendingMessageCount !== runtime.pendingMessageCount
        if (!sameLiveRuntimeState(previous, runtime)) {
          runtimeStateRef.current = runtime
          setState(runtime)
        }
        runtimeActive = runtime.isStreaming || runtimeCompacting
        setActivityStatus(runtimeCompacting
          ? 'compacting'
          : runtime.isStreaming
            ? 'running'
            : runtime.status === 'ready'
              ? 'idle'
              : null)
        const canRecover = runtime.status === 'ready' || runtime.status === 'initializing'
        // SSE 可能在 Worker 退出时断开；对账发现失败也要刷新已有恢复操作。
        if ((changed || forceRecovery) && runtime.status === 'failed') {
          setExtension(null)
          const disclosures = await liveApi.runtimeDisclosures(current.liveId, current.runtimeSessionId)
          if (!recoveryActive || epoch !== reconcileEpoch) return
          setRuntimeDisclosures(disclosures)
        }
        if ((changed || forceRecovery) && canRecover && product.capabilities.includes('recovery')) {
          const mode = runtime.status === 'ready' && !runtime.isStreaming ? 'settle' : 'live'
          void recover(mode)
        }
      } catch {
        // SSE remains the primary channel. State reconciliation is best-effort.
      }
    }

    const onVisible = () => {
      if (document.visibilityState === 'hidden') {
        hiddenSince = Date.now()
        return
      }
      const hiddenForMs = hiddenSince === null ? 0 : Math.max(0, Date.now() - hiddenSince)
      hiddenSince = null
      // A short healthy tab switch only checks state. Long throttled gaps still reconcile
      // bounded history because SSE does not guarantee replay of missed events.
      void reconcileState(shouldRecoverLiveOnVisible(hiddenForMs, streamDisconnected))
    }
    const onOnline = () => { void reconcileState(true) }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
    if (typeof window !== 'undefined') window.addEventListener('online', onOnline)
    const reconcileTimer = window.setInterval(() => {
      if (runtimeActive && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) {
        void reconcileState(false)
      }
    }, 5_000)

    const unsubscribe = liveApi.subscribe(
      current.liveId,
      current.runtimeSessionId,
      envelope => {
        setConnected(true)
        if (liveEventChangesTaskTranscript(envelope.normalizedEvent)) {
          lastProgressAtRef.current = Date.now()
          if (historyAtLatestRef.current) {
            setProjection(previous => ({
              ...previous,
              active: reduceLiveTaskEvent(previous.active, envelope),
            }))
          }
          if (!historyAtLatestRef.current || !followControllerRef.current.isFollowing) setNewRecords(true)
        }
        setState(previous => {
          const next = runtimeStateFromEvent(previous, envelope)
          runtimeStateRef.current = next
          return next
        })
        if (product.capabilities.includes('extension-ui') && envelope.normalizedEvent?.type === 'ui.request') {
          setExtension(envelope.normalizedEvent)
        }
        if (envelope.normalizedEvent?.type === 'runtime-disclosure.changed') {
          void liveApi.runtimeDisclosures(current.liveId, current.runtimeSessionId).then(
            setRuntimeDisclosures,
            () => undefined,
          )
        }
        if (envelope.normalizedEvent?.type === 'control.changed') {
          if (envelope.normalizedEvent.control === 'model' && product.capabilities.includes('model-switching')) {
            void liveApi.modelControl(current.liveId, current.runtimeSessionId).then(
              setModelControl,
              () => setSyncError(t('live.controlsSyncFailed')),
            )
          }
          if (envelope.normalizedEvent.control === 'thinking' && product.capabilities.includes('thinking-control')) {
            void liveApi.thinkingControl(current.liveId, current.runtimeSessionId).then(
              setThinking,
              () => setSyncError(t('live.controlsSyncFailed')),
            )
          }
        }
        if (envelope.normalizedEvent?.type === 'queue.update') {
          queueRevisionRef.current += 1
          const nextQueue = {
            steering: [...envelope.normalizedEvent.steering],
            followUp: [...envelope.normalizedEvent.followUp],
          }
          setQueue(nextQueue)
          setPendingQueue(previous => previous.filter(item => {
            const accepted = item.mode === 'steer' ? nextQueue.steering : nextQueue.followUp
            return !accepted.includes(item.text)
          }))
        }
        if (envelope.normalizedEvent?.type === 'status') {
          if (envelope.normalizedEvent.status === 'compacting') {
            runtimeCompacting = true
            runtimeActive = true
          } else if (envelope.normalizedEvent.status === 'running') {
            runtimeCompacting = false
            runtimeActive = true
          } else if (envelope.normalizedEvent.status === 'ready') {
            runtimeCompacting = false
            runtimeActive = runtimeStateRef.current?.isStreaming ?? false
          } else if (envelope.normalizedEvent.status === 'idle'
            || envelope.normalizedEvent.status === 'failed'
            || envelope.normalizedEvent.status === 'terminating'
            || envelope.normalizedEvent.status === 'terminated') {
            runtimeCompacting = false
            runtimeActive = false
            setActivityStatus(null)
            setExtension(null)
          }
          if (envelope.normalizedEvent.status === 'failed' && envelope.normalizedEvent.message
            && !historyAtLatestRef.current) {
            setError(envelope.normalizedEvent.message)
          }
          if (envelope.normalizedEvent.status === 'running') {
            lastProgressAtRef.current = Date.now()
            liveTurnRevisionRef.current += 1
          }
          if (envelope.normalizedEvent.status === 'running'
            || envelope.normalizedEvent.status === 'compacting'
            || envelope.normalizedEvent.status === 'idle') {
            setActivityStatus(envelope.normalizedEvent.status)
          } else if (envelope.normalizedEvent.status === 'ready') {
            setActivityStatus(null)
          }
          void liveApi.runtimeDisclosures(current.liveId, current.runtimeSessionId).then(
            setRuntimeDisclosures,
            () => undefined,
          )
          if (envelope.normalizedEvent.status === 'ready') {
            void recover()
            void liveApi.messageActions(current.liveId, current.runtimeSessionId).then(setMessageActions, () => undefined)
            if (product.capabilities.includes('command-discovery')) {
              void liveApi.commands(current.liveId, current.runtimeSessionId).then(setCommands, () => undefined)
            }
            if (product.capabilities.includes('model-switching')) {
              void liveApi.modelControl(current.liveId, current.runtimeSessionId).then(
                setModelControl,
                () => setSyncError(t('live.controlsSyncFailed')),
              )
            }
            if (product.capabilities.includes('thinking-control')) {
              void liveApi.thinkingControl(current.liveId, current.runtimeSessionId).then(
                setThinking,
                () => setSyncError(t('live.controlsSyncFailed')),
              )
            }
            if (product.capabilities.includes('queue')) {
              const queueRevision = queueRevisionRef.current
              void liveApi.queueState(current.liveId, current.runtimeSessionId).then(queueState => {
                if (queueRevisionRef.current === queueRevision) setQueue(queueState)
              }, () => undefined)
            }
          }
        }
        if (envelope.normalizedEvent?.type === 'completed' && product.capabilities.includes('command-discovery')) {
          void liveApi.commands(current.liveId, current.runtimeSessionId).then(setCommands, () => undefined)
        }
        if (envelope.normalizedEvent?.type === 'completed' && product.capabilities.includes('history-index')) {
          void liveApi.historyIndex(current.liveId, current.runtimeSessionId, { limit: 0 }).then(summary => {
            setHistoryIndex(previous => ({
              total: summary.total,
              items: previous?.items ?? [],
            }))
          }, () => undefined)
        }
        if (envelope.normalizedEvent?.type === 'completed') {
          // Terminal turns cannot retain a stale native approval dialog.
          setExtension(null)
          runtimeCompacting = false
          runtimeActive = false
          if (envelope.normalizedEvent.status === 'failed' && envelope.normalizedEvent.message
            && !historyAtLatestRef.current) {
            setError(envelope.normalizedEvent.message)
          }
          setActivityStatus('idle')
          void liveApi.messageActions(current.liveId, current.runtimeSessionId).then(setMessageActions, () => undefined)
          if (product.capabilities.includes('recovery')) {
            void recover('settle')
          } else if (historyAtLatestRef.current) {
            setProjection(previous => ({
              stable: previous.active.length
                ? [...previous.stable, ...previous.active]
                : previous.stable,
              active: [],
            }))
            snapshotBaseActiveCountRef.current = 0
          }
        }
        if (envelope.normalizedEvent?.type === 'error' && !historyAtLatestRef.current) {
          // Timeline owns errors at the live tail; banner is a fallback while browsing history.
          setError(envelope.normalizedEvent.message)
        }
      },
      () => {
        streamDisconnected = true
        setConnected(false)
      },
      () => {
        streamDisconnected = false
        setConnected(true)
        // EventSource reconnect cannot replay events missed during the gap.
        void reconcileState(true)
      },
    )
    return () => {
      recoveryActive = false
      recoveryGeneration += 1
      reconcileEpoch += 1
      pendingRecoveryMode = null
      window.clearInterval(reconcileTimer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
      if (typeof window !== 'undefined') window.removeEventListener('online', onOnline)
      unsubscribe()
    }
  }, [
    bootstrapTarget?.liveId,
    bootstrapTarget?.runtimeSessionId,
    current?.liveId,
    current?.runtimeSessionId,
    product?.liveId,
    product?.capabilities,
    t,
  ])


  useEffect(() => {
    if (!interruptNotice) return
    const timeout = window.setTimeout(() => setInterruptNotice(false), 2800)
    return () => window.clearTimeout(timeout)
  }, [interruptNotice])


  const followTextRevision = liveFollowTextRevision(projection.stable, projection.active)

  useEffect(() => {
    const controller = followControllerRef.current
    if (!controller.isFollowing || followFrameRef.current !== null) return
    followFrameRef.current = window.requestAnimationFrame(() => {
      followFrameRef.current = null
      const reader = readerRef.current
      if (!reader || !controller.isFollowing) return
      const target = Math.max(0, reader.scrollHeight - reader.clientHeight)
      if (Math.abs(reader.scrollTop - target) <= 6) return
      controller.beginProgrammaticScroll()
      controller.recordScrollWrite()
      reader.scrollTop = target
      if (followReleaseFrameRef.current !== null) window.cancelAnimationFrame(followReleaseFrameRef.current)
      followReleaseFrameRef.current = window.requestAnimationFrame(() => {
        followReleaseFrameRef.current = null
        controller.endProgrammaticScroll()
      })
    })
  }, [followTextRevision])

  useEffect(() => () => {
    if (followFrameRef.current !== null) window.cancelAnimationFrame(followFrameRef.current)
    if (followReleaseFrameRef.current !== null) window.cancelAnimationFrame(followReleaseFrameRef.current)
    followFrameRef.current = null
    followReleaseFrameRef.current = null
    followControllerRef.current.endProgrammaticScroll()
  }, [])


}
