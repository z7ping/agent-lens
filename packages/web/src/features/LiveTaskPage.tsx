import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type {
  LiveCommandDto,
  LiveEventDto,
  LiveInputCapabilitiesDto,
  LiveMessageActionContributionDto,
  LiveMessageDto,
  LiveModelControlDto,
  LiveQueueStateDto,
  LiveRuntimeActionContributionDto,
  LiveRuntimeDisclosureContributionDto,
  LiveRuntimeEventDto,
  LiveRuntimeStateDto,
  LiveSnapshotDto,
  LiveThinkingControlDto,
} from '@agent-lens/protocol'
import { AgentLensApi } from '../client/api'
import { liveApi, type LiveProductMetadata } from '../client/live'
import { liveAttachmentPreviewUrl } from '../client/live-attachments'
import { ComposerPillSelect } from '../components/ComposerPillSelect'
import { LocalPathActions } from '../components/LocalPathActions'
import { LiveRuntimeDisclosures } from '../components/LiveRuntimeDisclosures'
import { VirtualRoundMount } from '../components/VirtualRoundMount'
import {
  LiveMarkdownComposer,
  type LiveMarkdownComposerDraft,
  type LiveMarkdownComposerHandle,
} from '../components/LiveMarkdownComposer'
import { MarkdownContent } from '../components/MarkdownContent'
import {
  liveComposerDraftKey,
  readLiveComposerDraft,
  writeLiveComposerDraft,
} from '../components/live-composer-session-state'
import { OperationProgress } from '../components/StateViews'
import { Button, IconButton, Input, Textarea } from '../components/ui'
import { UiIcon } from '../components/UiIcon'
import {
  appendLiveInputHistory,
  appendOptimisticLiveUserMessage,
  projectLiveInputHistory,
  projectLiveSnapshotEntries,
  LiveTaskRoundProjector,
  liveTaskStableRoundPrefixLength,
  liveTaskRoundEstimate,
  liveEventChangesTaskTranscript,
  mergeLiveActiveProjectionItems,
  reduceLiveTaskEvent,
  settleLiveTaskProjectionItems,
  type LiveTaskProjectionAttachment,
  type LiveTaskProjectionItem,
  type LiveTaskRoundProjection,
} from './live-task-projection'
import { LiveFollowController } from './live-follow-controller'
import { sameStableLiveTaskRoundProps } from './live-task-render-boundary'
import { parseTaskLiveRuntimeLocation, taskLiveRuntimeStatus } from './task-live-runtime'
import { TaskHeader } from './TaskHeader'
import { TaskMessage } from './TaskMessage'
import { TaskRound } from './TaskRound'
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

function messageHasAttachments(message: LiveMessageDto): boolean {
  return message.parts.some(part => part.type === 'image' || part.type === 'file')
}

async function optimisticMessageAttachments(
  message: LiveMessageDto,
): Promise<LiveTaskProjectionAttachment[]> {
  const attachments = message.parts.filter(
    (part): part is Extract<LiveMessageDto['parts'][number], { type: 'image' | 'file' }> =>
      part.type === 'image' || part.type === 'file',
  )
  return Promise.all(attachments.map(async part => {
    const attachment: LiveTaskProjectionAttachment = {
      type: part.type,
      ...(part.name ? { name: part.name } : {}),
      ...(part.mimeType ? { mimeType: part.mimeType } : {}),
      ...(part.sizeBytes !== undefined ? { sizeBytes: part.sizeBytes } : {}),
    }
    if (part.type !== 'image') return attachment
    try {
      const response = await fetch(liveAttachmentPreviewUrl(part.attachmentId))
      if (!response.ok) return attachment
      const previewUrl = URL.createObjectURL(await response.blob())
      return { ...attachment, previewUrl }
    } catch {
      return attachment
    }
  }))
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
  if (event.type === 'title.update') {
    return current.title === event.title ? current : { ...current, title: event.title }
  }
  if (event.type === 'status') {
    if (event.status === 'initializing' || event.status === 'ready' || event.status === 'failed'
      || event.status === 'terminating' || event.status === 'terminated') {
      const terminal = event.status === 'failed' || event.status === 'terminating' || event.status === 'terminated'
      const nextStreaming = terminal ? false : current.isStreaming
      if (current.status === event.status && current.isStreaming === nextStreaming) return current
      return {
        ...current,
        status: event.status,
        ...(terminal ? { isStreaming: false } : {}),
      }
    }
    if (event.status === 'running') return current.isStreaming ? current : { ...current, isStreaming: true }
    if (event.status === 'idle') return current.isStreaming ? { ...current, isStreaming: false } : current
  }
  if (event.type === 'text.start' || event.type === 'text.delta'
    || event.type === 'reasoning.start' || event.type === 'reasoning.delta'
    || event.type === 'tool.start') {
    return current.isStreaming ? current : { ...current, isStreaming: true }
  }
  if (event.type === 'queue.update') {
    const pendingMessageCount = event.steering.length + event.followUp.length
    return current.pendingMessageCount === pendingMessageCount
      ? current
      : { ...current, pendingMessageCount }
  }
  if (event.type === 'completed') {
    return !current.isStreaming && current.pendingMessageCount === 0
      ? current
      : { ...current, isStreaming: false, pendingMessageCount: 0 }
  }
  return current
}

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

function mergeRuntimeState(
  runtimes: LiveRuntimeStateDto[],
  runtime: LiveRuntimeStateDto,
): LiveRuntimeStateDto[] {
  const index = runtimes.findIndex(item => item.runtimeSessionId === runtime.runtimeSessionId)
  if (index < 0) return [runtime, ...runtimes]
  const next = [...runtimes]
  next[index] = runtime
  return next
}

function runtimeSessionTitle(runtime: LiveRuntimeStateDto): string {
  return runtime.title?.trim() || workspaceDisplayName(runtime.workspacePath) || runtime.runtimeSessionId
}

function contributionText(
  value: LiveMessageActionContributionDto['label'],
  language: string,
): string {
  const normalized = language.replace(/_/g, '-').toLowerCase()
  const localized = Object.entries(value.localizations ?? {})
    .find(([locale]) => locale.toLowerCase() === normalized)?.[1]
  return localized || value.default
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

const LIVE_TASK_SNAPSHOT_PAGE_LIMIT = 120

function splitLiveProjectionItems(
  items: LiveTaskProjectionItem[],
  isStreaming: boolean,
): { stable: LiveTaskProjectionItem[]; active: LiveTaskProjectionItem[] } {
  const stableCount = liveTaskStableRoundPrefixLength(items, isStreaming)
  return {
    stable: items.slice(0, stableCount),
    active: items.slice(stableCount),
  }
}

function prependUniqueLiveProjectionItems(
  older: readonly LiveTaskProjectionItem[],
  current: readonly LiveTaskProjectionItem[],
): LiveTaskProjectionItem[] {
  const currentIds = new Set(current.map(item => item.id))
  return [...older.filter(item => !currentIds.has(item.id)), ...current]
}

function appendUniqueLiveProjectionItems(
  current: readonly LiveTaskProjectionItem[],
  newer: readonly LiveTaskProjectionItem[],
): LiveTaskProjectionItem[] {
  const currentIds = new Set(current.map(item => item.id))
  return [...current, ...newer.filter(item => !currentIds.has(item.id))]
}

async function loadBoundedRecoverySnapshot(
  liveId: string,
  runtimeSessionId: string,
  since: string | undefined,
): Promise<LiveSnapshotDto> {
  let snapshot = await liveApi.snapshot(
    liveId,
    runtimeSessionId,
    since,
    { limit: LIVE_TASK_SNAPSHOT_PAGE_LIMIT },
  )
  if (!since) return snapshot

  const entries = [...snapshot.entries]
  let pages = 1
  while (snapshot.page?.hasLater && snapshot.page.after) {
    if (pages >= 1_000) throw new Error('Live snapshot recovery exceeded the bounded page safety limit')
    snapshot = await liveApi.snapshot(
      liveId,
      runtimeSessionId,
      snapshot.page.after,
      { limit: LIVE_TASK_SNAPSHOT_PAGE_LIMIT },
    )
    entries.push(...snapshot.entries)
    pages += 1
  }
  return { ...snapshot, entries }
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

function GenericLiveItem({
  item,
  agentLabel,
  messageActions,
  actionPending,
  runtimeStreaming,
  onMessageAction,
}: {
  item: LiveTaskProjectionItem
  agentLabel: string
  messageActions: readonly LiveMessageActionContributionDto[]
  actionPending: string | null
  runtimeStreaming: boolean
  onMessageAction(action: LiveMessageActionContributionDto, item: Extract<LiveTaskProjectionItem, { kind: 'message' }>): void
}) {
  const { t, i18n } = useTranslation('task')
  if (item.kind === 'message') {
    const actions = item.entryId
      ? messageActions.filter(action => action.roles.includes(item.role))
      : []
    return <TaskMessage
      role={item.role}
      text={item.text}
      attachments={item.attachments}
      author={item.role === 'assistant' ? agentLabel : undefined}
      streaming={item.streaming}
      actions={actions.length
        ? actions.map(action => {
            const key = `${action.actionId}:${item.entryId}`
            const disabled = actionPending !== null || (action.requiresIdle === true && runtimeStreaming)
            const description = action.description ? contributionText(action.description, i18n.language) : undefined
            return <Button
              key={action.actionId}
              size="small"
              disabled={disabled}
              title={description}
              onClick={() => onMessageAction(action, item)}
            >
              {actionPending === key ? t('live.messageActionPending') : contributionText(action.label, i18n.language)}
            </Button>
          })
        : undefined}
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

const GenericLiveRound = memo(function GenericLiveRound({
  projection,
  agentLabel,
  eager,
  messageActions,
  actionPending,
  runtimeStreaming,
  onMessageAction,
}: {
  projection: LiveTaskRoundProjection
  agentLabel: string
  eager: boolean
  messageActions: readonly LiveMessageActionContributionDto[]
  actionPending: string | null
  runtimeStreaming: boolean
  onMessageAction(action: LiveMessageActionContributionDto, item: Extract<LiveTaskProjectionItem, { kind: 'message' }>): void
}) {
  return <VirtualRoundMount
    rootSelector=".pi-live-reader"
    flowRoot
    eager={eager}
    estimate={liveTaskRoundEstimate(projection)}
  >
    <TaskRound model={projection.model} className="live-task-round">
      {projection.items.map(item => <GenericLiveItem
        key={item.id}
        item={item}
        agentLabel={agentLabel}
        messageActions={messageActions}
        actionPending={actionPending}
        runtimeStreaming={runtimeStreaming}
        onMessageAction={onMessageAction}
      />)}
    </TaskRound>
  </VirtualRoundMount>
}, sameStableLiveTaskRoundProps)

const StableLiveRounds = memo(function StableLiveRounds({
  rounds,
  agentLabel,
  eagerTailCount,
  messageActions,
  actionPending,
  runtimeStreaming,
  onMessageAction,
}: {
  rounds: readonly LiveTaskRoundProjection[]
  agentLabel: string
  eagerTailCount: number
  messageActions: readonly LiveMessageActionContributionDto[]
  actionPending: string | null
  runtimeStreaming: boolean
  onMessageAction(action: LiveMessageActionContributionDto, item: Extract<LiveTaskProjectionItem, { kind: 'message' }>): void
}) {
  return <>
    {rounds.map((round, index) => <GenericLiveRound
      key={round.model.id}
      projection={round}
      agentLabel={agentLabel}
      eager={index >= rounds.length - eagerTailCount}
      messageActions={messageActions}
      actionPending={actionPending}
      runtimeStreaming={runtimeStreaming}
      onMessageAction={onMessageAction}
    />)}
  </>
})

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
  const [product, setProduct] = useState<LiveProductMetadata | null>(null)
  const [runtimes, setRuntimes] = useState<LiveRuntimeStateDto[]>([])
  const [state, setState] = useState<LiveRuntimeStateDto | null>(null)
  const [projection, setProjection] = useState<{
    stable: LiveTaskProjectionItem[]
    active: LiveTaskProjectionItem[]
  }>({ stable: [], active: [] })
  const [historyPage, setHistoryPage] = useState<LiveSnapshotDto['page'] | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyPagingArmed, setHistoryPagingArmed] = useState(false)
  const [historyPagingDirection, setHistoryPagingDirection] = useState<'older' | 'newer' | null>(null)
  const [messageActions, setMessageActions] = useState<LiveMessageActionContributionDto[]>([])
  const [messageActionPending, setMessageActionPending] = useState<string | null>(null)
  const [runtimeDisclosures, setRuntimeDisclosures] = useState<LiveRuntimeDisclosureContributionDto[]>([])
  const [runtimeActionPending, setRuntimeActionPending] = useState<string | null>(null)
  const [commands, setCommands] = useState<LiveCommandDto[]>([])
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
  const [activityStatus, setActivityStatus] = useState<'running' | 'compacting' | 'idle' | null>(null)
  const [bootstrapTarget, setBootstrapTarget] = useState<{ liveId: string; runtimeSessionId: string } | null>(null)
  const [syncError, setSyncError] = useState('')
  const [newRecords, setNewRecords] = useState(false)
  const [composerExpanded, setComposerExpanded] = useState(false)
  const [startupQueued, setStartupQueued] = useState<LiveMessageDto | null>(null)
  const [interruptNotice, setInterruptNotice] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pathError, setPathError] = useState('')
  const [composerHasContent, setComposerHasContent] = useState(false)
  const [composerAttachmentPending, setComposerAttachmentPending] = useState(false)
  const [inputHistory, setInputHistory] = useState<string[]>([])
  const [draft, setDraft] = useState<LiveMarkdownComposerDraft>({ revision: 0, value: '' })
  const composerRef = useRef<LiveMarkdownComposerHandle>(null)
  const readerRef = useRef<HTMLDivElement>(null)
  const historyLoadSentinelRef = useRef<HTMLDivElement>(null)
  const historyNewerSentinelRef = useRef<HTMLDivElement>(null)
  const lastReaderScrollTopRef = useRef(0)
  const followControllerRef = useRef(new LiveFollowController())
  const followFrameRef = useRef<number | null>(null)
  const followReleaseFrameRef = useRef<number | null>(null)
  const startupSendingRef = useRef(false)
  const leafIdRef = useRef<string | undefined>(undefined)
  const snapshotBaseActiveCountRef = useRef(0)
  const liveTurnRevisionRef = useRef(0)
  const roundProjectorRef = useRef(new LiveTaskRoundProjector())
  const queueRevisionRef = useRef(0)

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

  useEffect(() => {
    let cancelled = false
    setProduct(null)
    setRuntimes([])
    setState(null)
    setProjection({ stable: [], active: [] })
    setHistoryPage(null)
    setHistoryLoading(false)
    setHistoryPagingArmed(false)
    setHistoryPagingDirection(null)
    lastReaderScrollTopRef.current = 0
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

    const metadataRequest = liveApi.metadata(current.liveId).then(metadata => {
      if (!cancelled) setProduct(metadata)
      return metadata
    })

    const criticalRequest = liveApi.snapshot(
      current.liveId,
      current.runtimeSessionId,
      undefined,
      { limit: LIVE_TASK_SNAPSHOT_PAGE_LIMIT },
    ).then(
      snapshot => {
        if (cancelled) return
        setState(snapshot.state)
        setRuntimes(currentRuntimes => mergeRuntimeState(currentRuntimes, snapshot.state))
        const projectedItems = projectLiveSnapshotEntries(snapshot.entries)
        const nextProjection = splitLiveProjectionItems(projectedItems, snapshot.state.isStreaming)
        setProjection(nextProjection)
        setHistoryPage(snapshot.page ?? { hasEarlier: false })
        setInputHistory(projectLiveInputHistory(projectedItems))
        snapshotBaseActiveCountRef.current = nextProjection.active.length
        leafIdRef.current = snapshot.leafId ?? undefined
        setBootstrapTarget({ liveId: current.liveId, runtimeSessionId: current.runtimeSessionId })
      },
      async snapshotError => {
        if (cancelled) return
        setSyncError(snapshotError instanceof Error ? snapshotError.message : String(snapshotError))
        const runtime = await liveApi.state(current.liveId, current.runtimeSessionId)
        if (cancelled) return
        setState(runtime)
        setRuntimes(currentRuntimes => mergeRuntimeState(currentRuntimes, runtime))
        setBootstrapTarget({ liveId: current.liveId, runtimeSessionId: current.runtimeSessionId })
      },
    )

    void Promise.all([criticalRequest, metadataRequest]).then(async ([, matched]) => {
      if (cancelled) return
      const queueRevision = queueRevisionRef.current

      // Supporting reads: controls and the product-local runtime list can fill in
      // after the transcript is already visible.
      const [runtimeList, model, thinkingControl, queueState] = await Promise.all([
        liveApi.list(current.liveId).catch(() => []),
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
      setRuntimes(currentRuntimes => {
        const currentState = currentRuntimes.find(item => item.runtimeSessionId === current.runtimeSessionId)
        return currentState ? mergeRuntimeState(runtimeList, currentState) : runtimeList
      })
      setModelControl(model)
      setThinking(thinkingControl)
      if (queueState && queueRevisionRef.current === queueRevision) setQueue(queueState)

      // Opportunistic reads never hold the first transcript or primary controls.
      const [messageActionOptions, runtimeDisclosureOptions, commandOptions] = await Promise.all([
        liveApi.messageActions(current.liveId, current.runtimeSessionId).catch(() => []),
        liveApi.runtimeDisclosures(current.liveId, current.runtimeSessionId).catch(() => []),
        matched.capabilities.includes('command-discovery')
          ? liveApi.commands(current.liveId, current.runtimeSessionId).catch(() => [])
          : Promise.resolve([]),
      ])
      if (cancelled) return
      setMessageActions(messageActionOptions)
      setRuntimeDisclosures(runtimeDisclosureOptions)
      setCommands(commandOptions)
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
        setRuntimes(currentRuntimes => mergeRuntimeState(currentRuntimes, snapshot.state))
        const recovered = projectLiveSnapshotEntries(snapshot.entries)
        if (mode === 'settle' && snapshot.state.isStreaming) {
          // A new turn started before the previous completion reconciliation returned.
          // Keep the local active tail intact and do not advance leaf; the next settled
          // recovery will reconcile every persisted entry since the original leaf.
        } else if (!recoveryLeafId) {
          const nextProjection = splitLiveProjectionItems(recovered, snapshot.state.isStreaming)
          setProjection(nextProjection)
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

    const unsubscribe = liveApi.subscribe(
      current.liveId,
      current.runtimeSessionId,
      envelope => {
        setConnected(true)
        if (liveEventChangesTaskTranscript(envelope.normalizedEvent)) {
          setProjection(previous => ({
            ...previous,
            active: reduceLiveTaskEvent(previous.active, envelope),
          }))
          if (!followControllerRef.current.isFollowing) setNewRecords(true)
        }
        setState(previous => runtimeStateFromEvent(previous, envelope))
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
          if (envelope.normalizedEvent.status === 'failed' && envelope.normalizedEvent.message) {
            setError(envelope.normalizedEvent.message)
          }
          if (envelope.normalizedEvent.status === 'running') {
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
        if (envelope.normalizedEvent?.type === 'completed') {
          if (envelope.normalizedEvent.status === 'failed' && envelope.normalizedEvent.message) {
            setError(envelope.normalizedEvent.message)
          }
          setActivityStatus('idle')
          void liveApi.messageActions(current.liveId, current.runtimeSessionId).then(setMessageActions, () => undefined)
          if (product.capabilities.includes('recovery')) {
            void recover('settle')
          } else {
            setProjection(previous => ({
              stable: previous.active.length
                ? [...previous.stable, ...previous.active]
                : previous.stable,
              active: [],
            }))
            snapshotBaseActiveCountRef.current = 0
          }
        }
        if (envelope.normalizedEvent?.type === 'error') setError(envelope.normalizedEvent.message)
      },
      () => setConnected(false),
      () => {
        setConnected(true)
        void recover()
      },
    )
    return () => {
      recoveryActive = false
      recoveryGeneration += 1
      pendingRecoveryMode = null
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

  useEffect(() => {
    if (!state) return
    setRuntimes(currentRuntimes => mergeRuntimeState(currentRuntimes, state))
  }, [state])

  useEffect(() => {
    const controller = followControllerRef.current
    if (!controller.isFollowing || followFrameRef.current !== null) return
    followFrameRef.current = window.requestAnimationFrame(() => {
      followFrameRef.current = null
      const reader = readerRef.current
      if (!reader || !controller.isFollowing) return
      const target = Math.max(0, reader.scrollHeight - reader.clientHeight)
      if (Math.abs(reader.scrollTop - target) <= 1) return
      controller.beginProgrammaticScroll()
      controller.recordScrollWrite()
      reader.scrollTop = target
      if (followReleaseFrameRef.current !== null) window.cancelAnimationFrame(followReleaseFrameRef.current)
      followReleaseFrameRef.current = window.requestAnimationFrame(() => {
        followReleaseFrameRef.current = null
        controller.endProgrammaticScroll()
      })
    })
  }, [projection.stable, projection.active])

  useEffect(() => () => {
    if (followFrameRef.current !== null) window.cancelAnimationFrame(followFrameRef.current)
    if (followReleaseFrameRef.current !== null) window.cancelAnimationFrame(followReleaseFrameRef.current)
    followFrameRef.current = null
    followReleaseFrameRef.current = null
    followControllerRef.current.endProgrammaticScroll()
  }, [])

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
      const nextProjection = splitLiveProjectionItems(projected, snapshot.state.isStreaming)
      roundProjectorRef.current.reset()
      setProjection(nextProjection)
      setHistoryPage(snapshot.page ?? { hasEarlier: false })
      setState(snapshot.state)
      setRuntimes(currentRuntimes => mergeRuntimeState(currentRuntimes, snapshot.state))
      setInputHistory(projectLiveInputHistory(projected))
      snapshotBaseActiveCountRef.current = nextProjection.active.length
      leafIdRef.current = snapshot.leafId ?? undefined
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
      roundProjectorRef.current.reset()
      setProjection(previous => ({
        stable: prependUniqueLiveProjectionItems(older, previous.stable),
        active: previous.active,
      }))
      setHistoryPage(previous => ({
        hasEarlier: snapshot.page?.hasEarlier ?? false,
        ...(snapshot.page?.before ? { before: snapshot.page.before } : {}),
        ...(previous?.hasLater ? { hasLater: true } : {}),
        ...(previous?.after ? { after: previous.after } : {}),
      }))
      setState(snapshot.state)
      setRuntimes(currentRuntimes => mergeRuntimeState(currentRuntimes, snapshot.state))
      setSyncError('')
      window.requestAnimationFrame(() => {
        const currentReader = readerRef.current
        if (!currentReader || currentReader !== reader) return
        const addedHeight = Math.max(0, currentReader.scrollHeight - previousScrollHeight)
        currentReader.scrollTop = previousScrollTop + addedHeight
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
      roundProjectorRef.current.reset()
      setProjection(previous => ({
        stable: appendUniqueLiveProjectionItems(previous.stable, newer),
        active: previous.active,
      }))
      setHistoryPage(previous => ({
        hasEarlier: previous?.hasEarlier ?? false,
        ...(previous?.before ? { before: previous.before } : {}),
        ...(snapshot.page?.hasLater ? { hasLater: true } : {}),
        ...(snapshot.page?.after ? { after: snapshot.page.after } : {}),
      }))
      setState(snapshot.state)
      setRuntimes(currentRuntimes => mergeRuntimeState(currentRuntimes, snapshot.state))
      setSyncError('')
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
      setHistoryPage(snapshot.page ?? { hasEarlier: false })
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
      setRuntimes(currentRuntimes => mergeRuntimeState(currentRuntimes, result.runtime))
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
      setThinking(await liveApi.thinkingControl(current.liveId, current.runtimeSessionId))
      composerRef.current?.focus({ preventScroll: true })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [busy, current, thinking])

  const roundSegments = useMemo(
    () => roundProjectorRef.current.projectSegmented(projection.stable, projection.active),
    [projection.stable, projection.active],
  )
  const stableEagerTailCount = Math.max(0, 2 - roundSegments.active.length)
  const turnRailItems = useMemo(
    () => [...roundSegments.stable, ...roundSegments.active].map(round => ({
      id: round.model.id,
      semanticId: round.model.semanticId,
      label: round.model.label,
      preview: round.model.preview,
      error: round.model.errorCount > 0,
      state: round.model.state,
    })),
    [roundSegments],
  )
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
    {!embedded && <aside className="pi-live-sessions" aria-label={t('live.sidebar.title')}>
      <div className="pi-live-sessions-head">
        <div>
          <b>{t('live.sidebar.title')}</b>
          <small>{t('live.sidebar.closeKeepsRunning')}</small>
        </div>
        <Button size="small" onClick={() => navigate('/review/new')}>{t('live.sidebar.newTask')}</Button>
      </div>
      <div className="pi-live-session-scroll">
        {runtimes.map(runtime => {
          const active = runtime.runtimeSessionId === current.runtimeSessionId
          return <button
            type="button"
            key={runtime.runtimeSessionId}
            className={`pi-live-session ${active ? 'active' : ''}`}
            onClick={() => navigate(`/review/live/${encodeURIComponent(current.liveId)}/${encodeURIComponent(runtime.runtimeSessionId)}`)}
          >
            <div className="pi-live-session-top">
              <span className={runtime.isStreaming || runtime.status === 'initializing' ? 'pi-live-pulse' : 'pi-live-idle-dot'} aria-hidden="true"/>
              <span>{agentLabel}</span>
              <span>{statusLabel(runtime, t)}</span>
            </div>
            <div className="pi-live-session-title" title={runtime.workspacePath || runtime.runtimeSessionId}>
              {runtimeSessionTitle(runtime)}
            </div>
            <div className="pi-live-session-foot">
              <span title={runtime.runtimeSessionId}>{runtime.runtimeSessionId}</span>
              {runtime.pendingMessageCount > 0 && <span>{t('live.sidebar.pending', { count: runtime.pendingMessageCount })}</span>}
            </div>
          </button>
        })}
        {!runtimes.length && <div className="pi-live-side-empty">{t('live.sidebar.empty')}</div>}
        <button
          type="button"
          className="pi-live-review-link"
          onClick={() => navigate(product ? `/review?source=${encodeURIComponent(product.productId)}` : '/review')}
        >
          {t('live.sidebar.history')} <UiIcon name="arrow-right" size={14}/>
        </button>
      </div>
    </aside>}

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
    >
      <TaskHeader
        marker={<span className="agent-icon" aria-hidden="true"><UiIcon name="agent" size={14}/></span>}
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
          {!state && !error && <div className="pi-live-startup-spotlight">
            <OperationProgress
              statusLabel={t('live.loadingStatus')}
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
