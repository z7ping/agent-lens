import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type {
  LiveInputCapabilitiesDto,
  LiveMessageDto,
  LiveProductDto,
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
import { Button, IconButton } from '../components/ui'
import { UiIcon } from '../components/UiIcon'
import {
  appendOptimisticLiveUserMessage,
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
  if (event.type === 'completed') return { ...current, isStreaming: false, pendingMessageCount: 0 }
  return current
}

function statusLabel(state: LiveRuntimeStateDto | null, t: ReturnType<typeof useTranslation>['t']): string {
  if (!state) return t('center.runtimeStatus.initializing')
  const status = taskLiveRuntimeStatus(state)
  return t(`center.runtimeStatus.${status}`)
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
  const [product, setProduct] = useState<LiveProductDto | null>(null)
  const [state, setState] = useState<LiveRuntimeStateDto | null>(null)
  const [items, setItems] = useState<LiveTaskProjectionItem[]>([])
  const [thinking, setThinking] = useState<LiveThinkingControlDto | null>(null)
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [composerHasContent, setComposerHasContent] = useState(false)
  const [composerAttachmentPending, setComposerAttachmentPending] = useState(false)
  const [draft, setDraft] = useState<LiveMarkdownComposerDraft>({ revision: 0, value: '' })
  const composerRef = useRef<LiveMarkdownComposerHandle>(null)

  const clearComposer = useCallback(() => {
    setDraft(currentDraft => ({ revision: currentDraft.revision + 1, value: '' }))
    setComposerHasContent(false)
  }, [])

  useEffect(() => {
    let cancelled = false
    setProduct(null)
    setState(null)
    setItems([])
    setThinking(null)
    setConnected(false)
    setError('')

    if (!current) {
      setError(t('live.invalidRuntime'))
      return () => { cancelled = true }
    }

    void liveApi.products().then(async products => {
      if (cancelled) return
      const matched = products.find(item => item.liveId === current.liveId)
      if (!matched) throw new Error(t('live.productUnavailable'))
      setProduct(matched)
      const [runtime, snapshot, thinkingControl] = await Promise.all([
        liveApi.state(current.liveId, current.runtimeSessionId),
        liveApi.snapshot(current.liveId, current.runtimeSessionId),
        matched.capabilities.includes('thinking-control')
          ? liveApi.thinkingControl(current.liveId, current.runtimeSessionId).catch(() => null)
          : Promise.resolve(null),
      ])
      if (cancelled) return
      setState(runtime)
      setItems(projectLiveSnapshotEntries(snapshot.entries))
      setThinking(thinkingControl)
    }).catch(reason => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    })

    return () => { cancelled = true }
  }, [current?.liveId, current?.runtimeSessionId, t])

  useEffect(() => {
    if (!current || !product?.capabilities.includes('stream')) return
    const unsubscribe = liveApi.subscribe(
      current.liveId,
      current.runtimeSessionId,
      envelope => {
        setConnected(true)
        setItems(previous => reduceLiveTaskEvent(previous, envelope))
        setState(previous => runtimeStateFromEvent(previous, envelope))
        if (envelope.normalizedEvent?.type === 'error') setError(envelope.normalizedEvent.message)
      },
      () => setConnected(false),
    )
    return unsubscribe
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
    && !composerAttachmentPending,
  )
  const canInterrupt = Boolean(
    current
    && state?.isStreaming
    && product?.capabilities.includes('interrupt')
    && !busy,
  )

  const send = useCallback(async (message: LiveMessageDto) => {
    if (!current || !product || !state || !canSubmit) return
    const unsupported = unsupportedInput(message, product.inputCapabilities)
    if (unsupported) {
      setError(t('live.unsupportedInput', { type: t(`live.input.${unsupported}`) }))
      return
    }
    const optimisticText = messageText(message)
    setBusy(true)
    setError('')
    if (optimisticText) {
      setItems(previous => appendOptimisticLiveUserMessage(previous, optimisticText))
    }
    clearComposer()
    try {
      const behavior = state.isStreaming
        ? product.capabilities.includes('steer')
          ? 'steer' as const
          : 'follow-up' as const
        : 'normal' as const
      await liveApi.send(current.liveId, current.runtimeSessionId, message, behavior)
      setState(previous => previous ? { ...previous, isStreaming: true } : previous)
      composerRef.current?.focus({ preventScroll: true })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [canSubmit, clearComposer, current, product, state, t])

  const interrupt = useCallback(async () => {
    if (!current || !canInterrupt) return
    setBusy(true)
    setError('')
    try {
      await liveApi.interrupt(current.liveId, current.runtimeSessionId)
      setState(previous => previous ? { ...previous, isStreaming: false, pendingMessageCount: 0 } : previous)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
      composerRef.current?.focus({ preventScroll: true })
    }
  }, [canInterrupt, current])

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
        <div className="pi-live-composer">
          <div className="pi-live-editor">
            <LiveMarkdownComposer
              ref={composerRef}
              draft={draft}
              onDraftPresenceChange={setComposerHasContent}
              canSubmit={canSubmit}
              onSubmit={message => { void send(message) }}
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
