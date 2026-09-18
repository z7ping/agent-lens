import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type {
  LiveEventDto,
  LiveInputCapabilitiesDto,
  LiveMessageDto,
  LiveModelControlDto,
  LiveProductDto,
  LiveQueueStateDto,
  LiveRuntimeEventDto,
  LiveRuntimeStateDto,
  LiveThinkingControlDto,
} from '@agent-lens/protocol'
import { liveApi } from '../client/live'
import { ComposerPillSelect } from '../components/ComposerPillSelect'
import {
  LiveMarkdownComposer,
  type LiveMarkdownComposerDraft,
  type LiveMarkdownComposerHandle,
} from '../components/LiveMarkdownComposer'
import { MarkdownContent } from '../components/MarkdownContent'
import {
  liveComposerDraftKey,
  readLiveComposerDraft,
} from '../components/live-composer-session-state'
import { Button, IconButton, Input, Textarea } from '../components/ui'
import { UiIcon } from '../components/UiIcon'
import {
  appendLiveInputHistory,
  appendOptimisticLiveUserMessage,
  projectLiveInputHistory,
  projectLiveSnapshotEntries,
  reduceLiveTaskEvent,
  type LiveTaskProjectionItem,
} from './live-task-projection'
import { parseTaskLiveRuntimeLocation, taskLiveRuntimeStatus } from './task-live-runtime'
import { TaskHeader } from './TaskHeader'
import { TaskMessage } from './TaskMessage'
import { TaskSurface } from './TaskSurface'
import { TaskThinking } from './TaskThinking'
import { TaskToolRow } from './TaskToolRow'
import { workspaceDisplayName } from './task-detail-model'

function messageText(message: LiveMessageDto): string {
  return message.parts
    .flatMap(part => part.type === 'text' || part.type === 'large-text' ? [part.text] : [])
    .join('\n\n')
    .trim()
}

function unsupportedInput(
  message: LiveMessageDto,
  capabilities: LiveInputCapabilitiesDto,
): 'largeText' | 'image' | 'file' | null {
  for (const part of message.parts) {
    if (part.type === 'large-text' && capabilities.largeText === 'unsupported') return 'largeText'
    if (part.type === 'image' && capabilities.image === 'unsupported') return 'image'
    if (part.type === 'file' && capabilities.file === 'unsupported') return 'file'
  }
  return null
}

function runtimeStateFromEvent(
  current: LiveRuntimeStateDto | null,
  envelope: LiveRuntimeEventDto,
): LiveRuntimeStateDto | null {
  if (!current || !envelope.normalizedEvent) return current
  const event = envelope.normalizedEvent
  if (event.type === 'status') {
    if (event.status === 'initializing' || event.status === 'ready' || event.status === 'failed'
      || event.status === 'terminating' || event.status === 'terminated') {
      return { ...current, status: event.status }
    }
    if (event.status === 'running') return { ...current, isStreaming: true }
    if (event.status === 'idle') return { ...current, isStreaming: false }
  }
  if (event.type === 'text.start' || event.type === 'text.delta'
    || event.type === 'reasoning.start' || event.type === 'reasoning.delta'
    || event.type === 'tool.start') {
    return { ...current, isStreaming: true }
  }
  if (event.type === 'queue.update') {
    return { ...current, pendingMessageCount: event.steering.length + event.followUp.length }
  }
  if (event.type === 'completed') return { ...current, isStreaming: false, pendingMessageCount: 0 }
  return current
}

function statusLabel(state: LiveRuntimeStateDto | null, t: ReturnType<typeof useTranslation>['t']): string {
  if (!state) return t('center.runtimeStatus.initializing')
  const status = taskLiveRuntimeStatus(state)
  return t(`center.runtimeStatus.${status}`)
}

type LiveUiRequest = Extract<LiveEventDto, { type: 'ui.request' }>
type LiveQueueMode = 'steer' | 'follow-up'
type PendingQueueSubmission = { id: string; mode: LiveQueueMode; text: string }
type RestoredQueueDraft = { id: string; mode: LiveQueueMode; text: string }
type LiveQueueListItem = {
  id: string
  mode: LiveQueueMode
  text: string
  active: boolean
  pending?: boolean | undefined
  queueIndex?: number | undefined
}

function emptyLiveQueue(): LiveQueueStateDto {
  return { steering: [], followUp: [] }
}

function restoredQueueDrafts(queue: LiveQueueStateDto): RestoredQueueDraft[] {
  const stamp = Date.now()
  return [
    ...queue.steering.map((text, index) => ({ id: `steer-${stamp}-${index}`, mode: 'steer' as const, text })),
    ...queue.followUp.map((text, index) => ({ id: `follow-${stamp}-${index}`, mode: 'follow-up' as const, text })),
  ]
}

function queueTextMessage(text: string): LiveMessageDto {
  return { parts: [{ type: 'text', text }] }
}

function mergeLiveProjectionItems(
  previous: LiveTaskProjectionItem[],
  incoming: LiveTaskProjectionItem[],
): LiveTaskProjectionItem[] {
  const items = new Map(previous.map(item => [item.id, item] as const))
  for (const item of incoming) items.set(item.id, item)
  return [...items.values()]
}

function LiveExtensionPrompt({
  request,
  pending,
  onAnswer,
}: {
  request: LiveUiRequest
  pending: boolean
  onAnswer(value: unknown): void
}) {
  const { t } = useTranslation('task')
  const [value, setValue] = useState(request.prefill ?? '')
  useEffect(() => setValue(request.prefill ?? ''), [request.requestId, request.prefill])

  const title = request.title || t('live.extension.title')
  if (request.method === 'confirm') {
    return <div className="pi-live-blocking" role="dialog" aria-label={title}>
      <div><b>{title}</b>{request.message && <span>{request.message}</span>}</div>
      <div className="pi-live-blocking-actions">
        <Button size="small" disabled={pending} onClick={() => onAnswer({ confirmed: false })}>{t('live.extension.reject')}</Button>
        <Button size="small" variant="primary" disabled={pending} onClick={() => onAnswer({ confirmed: true })}>{t('live.extension.allow')}</Button>
      </div>
    </div>
  }
  if (request.method === 'select') {
    return <div className="pi-live-blocking" role="dialog" aria-label={title}>
      <div><b>{title}</b>{request.message && <span>{request.message}</span>}</div>
      <div className="pi-live-blocking-options">
        {(request.options ?? []).map(option => <Button size="small" disabled={pending} key={option} onClick={() => onAnswer({ value: option })}>{option}</Button>)}
        <Button size="small" disabled={pending} onClick={() => onAnswer({ cancelled: true })}>{t('live.extension.cancel')}</Button>
      </div>
    </div>
  }
  return <div className="pi-live-blocking pi-live-blocking-input" role="dialog" aria-label={title}>
    <div><b>{title}</b>{request.message && <span>{request.message}</span>}</div>
    {request.method === 'editor'
      ? <Textarea className="pi-live-blocking-field" value={value} onChange={event => setValue(event.target.value)} placeholder={request.placeholder}/>
      : <Input className="pi-live-blocking-field" value={value} onChange={event => setValue(event.target.value)} placeholder={request.placeholder}/>}
    <div className="pi-live-blocking-actions">
      <Button size="small" disabled={pending} onClick={() => onAnswer({ cancelled: true })}>{t('live.extension.cancel')}</Button>
      <Button size="small" variant="primary" disabled={pending} onClick={() => onAnswer({ value })}>{t('live.extension.submit')}</Button>
    </div>
  </div>
}

function GenericLiveItem({ item, agentLabel }: { item: LiveTaskProjectionItem; agentLabel: string }) {
  const { t } = useTranslation('task')
  if (item.kind === 'message') {
    return <TaskMessage
      role={item.role}
      text={item.text}
      author={item.role === 'assistant' ? agentLabel : undefined}
      streaming={item.streaming}
    />
  }
  if (item.kind === 'thinking') {
    return <TaskThinking
      model={{
        id: item.id,
        label: t('thinking.executionProcess'),
        text: item.text,
        preview: item.text.replace(/\s+/g, ' ').trim().slice(0, 96),
        state: item.streaming ? 'running' : 'settled',
      }}
      defaultExpanded={item.streaming}
    >
      <MarkdownContent text={item.text} streaming={item.streaming}/>
    </TaskThinking>
  }
  return <TaskToolRow
    model={{
      id: item.id,
      name: item.name,
      kind: 'tool',
      kindLabel: t('tool.kind.tool'),
      status: item.status,
      primary: item.inputPreview,
      output: item.output,
      durationMs: item.durationMs,
    }}
    details={item.output ? <MarkdownContent text={item.output}/> : undefined}
  />
}

export function LiveTaskPage({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation('task')
  const location = useLocation()
  const navigate = useNavigate()
  const current = useMemo(() => parseTaskLiveRuntimeLocation(location.pathname), [location.pathname])
  const composerDraftKey = useMemo(
    () => current ? liveComposerDraftKey(current.liveId, current.runtimeSessionId) : '',
    [current?.liveId, current?.runtimeSessionId],
  )
  const [product, setProduct] = useState<LiveProductDto | null>(null)
  const [state, setState] = useState<LiveRuntimeStateDto | null>(null)
  const [items, setItems] = useState<LiveTaskProjectionItem[]>([])
  const [modelControl, setModelControl] = useState<LiveModelControlDto | null>(null)
  const [thinking, setThinking] = useState<LiveThinkingControlDto | null>(null)
  const [extension, setExtension] = useState<LiveUiRequest | null>(null)
  const [extensionPending, setExtensionPending] = useState(false)
  const [streamingBehavior, setStreamingBehavior] = useState<LiveQueueMode>('steer')
  const [queue, setQueue] = useState<LiveQueueStateDto>(() => emptyLiveQueue())
  const [pendingQueue, setPendingQueue] = useState<PendingQueueSubmission[]>([])
  const [restoredQueue, setRestoredQueue] = useState<RestoredQueueDraft[]>([])
  const [queueMutationPending, setQueueMutationPending] = useState(false)
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [composerHasContent, setComposerHasContent] = useState(false)
  const [composerAttachmentPending, setComposerAttachmentPending] = useState(false)
  const [inputHistory, setInputHistory] = useState<string[]>([])
  const [draft, setDraft] = useState<LiveMarkdownComposerDraft>({ revision: 0, value: '' })
  const composerRef = useRef<LiveMarkdownComposerHandle>(null)
  const leafIdRef = useRef<string | undefined>(undefined)
  const queueRevisionRef = useRef(0)

  const setComposerValue = useCallback((value: string) => {
    setDraft(currentDraft => ({ revision: currentDraft.revision + 1, value }))
    setComposerHasContent(Boolean(value.trim()))
  }, [])

  const clearComposer = useCallback(() => {
    setComposerValue('')
  }, [setComposerValue])

  useEffect(() => {
    let cancelled = false
    setProduct(null)
    setState(null)
    setItems([])
    setModelControl(null)
    setThinking(null)
    setExtension(null)
    setQueue(emptyLiveQueue())
    setPendingQueue([])
    setRestoredQueue([])
    setQueueMutationPending(false)
    queueRevisionRef.current += 1
    leafIdRef.current = undefined
    setConnected(false)
    setError('')
    setInputHistory([])
    setComposerValue(current ? readLiveComposerDraft(composerDraftKey) : '')

    if (!current) {
      setError(t('live.invalidRuntime'))
      return () => { cancelled = true }
    }

    void liveApi.products().then(async products => {
      if (cancelled) return
      const matched = products.find(item => item.liveId === current.liveId)
      if (!matched) throw new Error(t('live.productUnavailable'))
      setProduct(matched)
      const queueRevision = queueRevisionRef.current
      const [runtime, snapshot, model, thinkingControl, queueState] = await Promise.all([
        liveApi.state(current.liveId, current.runtimeSessionId),
        liveApi.snapshot(current.liveId, current.runtimeSessionId),
        matched.capabilities.includes('model-switching')
          ? liveApi.modelControl(current.liveId, current.runtimeSessionId).catch(() => null)
          : Promise.resolve(null),
        matched.capabilities.includes('thinking-control')
          ? liveApi.thinkingControl(current.liveId, current.runtimeSessionId).catch(() => null)
          : Promise.resolve(null),
        matched.capabilities.includes('queue')
          ? liveApi.queueState(current.liveId, current.runtimeSessionId).catch(() => null)
          : Promise.resolve(null),
      ])
      if (cancelled) return
      const projectedItems = projectLiveSnapshotEntries(snapshot.entries)
      setState(runtime)
      setItems(projectedItems)
      setInputHistory(projectLiveInputHistory(projectedItems))
      leafIdRef.current = snapshot.leafId ?? undefined
      setModelControl(model)
      setThinking(thinkingControl)
      if (queueState && queueRevisionRef.current === queueRevision) setQueue(queueState)
    }).catch(reason => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    })

    return () => { cancelled = true }
  }, [composerDraftKey, current?.liveId, current?.runtimeSessionId, setComposerValue, t])

  useEffect(() => {
    if (!current || !product?.capabilities.includes('stream')) return
    let opened = false
    let recoveryGeneration = 0
    const recover = async () => {
      if (!product.capabilities.includes('recovery')) return
      const generation = ++recoveryGeneration
      try {
        const queueRevision = queueRevisionRef.current
        const [snapshot, queueState] = await Promise.all([
          liveApi.snapshot(current.liveId, current.runtimeSessionId, leafIdRef.current),
          product.capabilities.includes('queue')
            ? liveApi.queueState(current.liveId, current.runtimeSessionId).catch(() => null)
            : Promise.resolve(null),
        ])
        if (generation !== recoveryGeneration) return
        setState(snapshot.state)
        const recovered = projectLiveSnapshotEntries(snapshot.entries)
        setItems(previous => leafIdRef.current ? mergeLiveProjectionItems(previous, recovered) : recovered)
        leafIdRef.current = snapshot.leafId ?? leafIdRef.current
        if (queueState && queueRevisionRef.current === queueRevision) setQueue(queueState)
      } catch (reason) {
        if (generation === recoveryGeneration) setError(reason instanceof Error ? reason.message : String(reason))
      }
    }
    const unsubscribe = liveApi.subscribe(
      current.liveId,
      current.runtimeSessionId,
      envelope => {
        setConnected(true)
        setItems(previous => reduceLiveTaskEvent(previous, envelope))
        setState(previous => runtimeStateFromEvent(previous, envelope))
        if (product.capabilities.includes('extension-ui') && envelope.normalizedEvent?.type === 'ui.request') {
          setExtension(envelope.normalizedEvent)
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
        if (envelope.normalizedEvent?.type === 'error') setError(envelope.normalizedEvent.message)
      },
      () => setConnected(false),
      () => {
        setConnected(true)
        if (opened) void recover()
        opened = true
      },
    )
    return () => {
      recoveryGeneration += 1
      unsubscribe()
    }
  }, [current?.liveId, current?.runtimeSessionId, product?.liveId, product?.capabilities])

  const canQueueWhileStreaming = Boolean(
    product?.capabilities.includes('steer') || product?.capabilities.includes('queue'),
  )
  const canSubmit = Boolean(
    current
    && product?.capabilities.includes('send')
    && state?.status === 'ready'
    && (!state.isStreaming || canQueueWhileStreaming)
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
    if (behavior === 'normal' && optimisticText) {
      setItems(previous => appendOptimisticLiveUserMessage(previous, optimisticText))
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
      if (optimisticText && message.parts.every(part => part.type === 'text' || part.type === 'large-text')) {
        setComposerValue(optimisticText)
      }
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (pending) setPendingQueue(previous => previous.filter(item => item.id !== pending.id))
      setBusy(false)
    }
  }, [canSubmit, clearComposer, current, product, setComposerValue, state, streamingBehavior, t])

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
      setState(previous => previous ? { ...previous, isStreaming: false, pendingMessageCount: 0 } : previous)
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

  const changeThinking = useCallback(async (value: string) => {
    if (!current || !thinking || busy) return
    setBusy(true)
    setError('')
    try {
      const nextState = await liveApi.setThinkingControl(current.liveId, current.runtimeSessionId, value)
      setState(nextState)
      setThinking(await liveApi.thinkingControl(current.liveId, current.runtimeSessionId))
      composerRef.current?.focus({ preventScroll: true })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [busy, current, thinking])

  if (!current) {
    return <main className={`pi-live-page ${embedded ? 'pi-live-page-embedded' : ''}`}>
      <div className="pi-live-error" role="alert">{error || t('live.invalidRuntime')}</div>
    </main>
  }

  const agentLabel = product?.displayName ?? current.liveId
  const workspace = workspaceDisplayName(state?.workspacePath)
  const title = workspace || t('center.history.genericAgentTask', { agent: agentLabel })
  const runtimeStatus = statusLabel(state, t)
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
    <TaskSurface mode="live" className="pi-live-workspace live-task-workspace">
      <TaskHeader
        marker={<span className="agent-icon" aria-hidden="true"><UiIcon name="agent" size={14}/></span>}
        agent={agentLabel}
        context={workspace || t('header.unlinkedProject')}
        status={runtimeStatus}
        title={title}
        metrics={[]}
        infoItems={[
          { label: t('live.runtimeId'), value: current.runtimeSessionId },
          ...(state?.workspacePath ? [{ label: t('header.workspace'), value: state.workspacePath }] : []),
        ]}
        actions={<>
          {canInterrupt && <Button size="small" variant="danger" disabled={busy} onClick={() => void interrupt()}>{t('live.interrupt')}</Button>}
          <Button size="small" disabled={busy} onClick={() => void terminate()}>{t('live.terminate')}</Button>
        </>}
      />

      <div className="pi-live-reader live-task-reader">
        <div className="pi-live-document live-task-document">
          {items.map(item => <GenericLiveItem key={item.id} item={item} agentLabel={agentLabel}/>)}
          {!items.length && state?.status === 'ready' && <div className="pi-live-empty">{t('live.empty')}</div>}
          {error && <div className="pi-live-error pi-live-reader-error" role="alert">{error}</div>}
        </div>
      </div>

      <div className="pi-live-compose-wrap live-task-compose-wrap">
        <div className="pi-live-float-stack">
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
        <div className="pi-live-composer">
          <div className="pi-live-editor">
            <LiveMarkdownComposer
              ref={composerRef}
              draft={draft}
              draftKey={composerDraftKey || undefined}
              inputHistory={inputHistory}
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
            <span className="pi-live-compose-runtime" title={connected ? t('live.connected') : t('live.connecting')}>
              <span className="pi-live-idle-dot" aria-hidden="true"/>
              {runtimeStatus}
            </span>
            <div className="pi-live-compose-settings">
              {modelControl && <ComposerPillSelect
                ariaLabel={t('live.model')}
                title={t('live.model')}
                value={modelControl.value ?? ''}
                placeholder={modelControl.label || t('live.model')}
                className="pi-live-model-picker"
                menuWidth={280}
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
                title={t('live.thinking')}
                value={thinking.value}
                placeholder={thinking.label || thinking.value}
                className="pi-live-thinking-picker"
                menuWidth={180}
                disabled={busy || state?.status !== 'ready'}
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
