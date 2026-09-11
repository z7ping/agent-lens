import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { JsonValue, PiLiveControlsDto, PiLiveQueueDto, PiLiveSnapshotDto, PiLiveStateDto } from '@agent-lens/protocol'
import { PiLiveRequestError, piLiveApi, type PiLiveTransportDiagnostics } from '../client/pi-live'
import { VirtualRoundMount } from '../components/VirtualRoundMount'
import { ComposerPillSelect } from '../components/ComposerPillSelect'
import { PiMarkdownComposer, type PiMarkdownComposerHandle } from '../components/PiMarkdownComposer'
import { PiRuntimeMenu } from '../components/PiRuntimeMenu'
import { PiStartupDisclosure, piStartupSummary } from '../components/PiStartupDisclosure'
import { OperationProgress } from '../components/StateViews'
import { Button, Disclosure, IconButton, Input, Textarea } from '../components/ui'
import { UiIcon } from '../components/UiIcon'
import { appendPiLiveDelta, finishPiLiveContentBlock, finishPiLiveTool, markPiLiveItemsRunning, reconcilePiLiveItems, settlePiLiveItems, startPiLiveContentBlock, startPiLiveTool, updatePiLiveTool } from './pi-live-current'
import { omitPiLivePromptMessages, projectPiLiveHistory, type PiLiveHistoryItem } from './pi-live-history'
import { PiLiveCurrentTaskRound, PiLiveHistoryTaskRound } from './PiLiveTaskRound'
import { piLiveSessionTitle, piLiveTaskRoundEstimate, projectPiLiveRunningRound, projectPiLiveTaskDetail, projectPiLiveTaskRounds } from './pi-live-task-projection'
import { TaskHeader } from './TaskHeader'
import { TaskSurface } from './TaskSurface'
import { workspaceDisplayName } from './task-detail-model'
import { agentLensI18n } from '../i18n/runtime'

type QueueMode = 'steer' | 'followUp'
type PendingQueueSubmission = { id: string; mode: QueueMode; text: string }
interface RestoredDraft { id: string; mode: QueueMode; text: string }
interface ExtensionRequest {
  id: string
  method: string
  title: string
  message: string
  options: string[]
  placeholder: string
  prefill: string
}

const PI_LIVE_EAGER_CHUNKS = 2
function piLiveStartupBackground() {
  return {
    model: {
      id: 'background:startup',
      label: agentLensI18n.t('piLive:common.backgroundActivity'),
      state: 'settled' as const,
      toolCount: 0,
      errorCount: 0,
      durationMs: 0,
      highLatency: false,
    },
    items: [] as PiLiveHistoryItem[],
    continuation: false,
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

const PI_INITIALIZATION_STAGE_VALUES = new Set(['starting_worker', 'loading_sdk', 'loading_resources', 'creating_session', 'binding_extensions', 'ready'])

function parseInitializationTimings(value: unknown): NonNullable<PiLiveStateDto['initializationTimings']> | undefined {
  if (!Array.isArray(value)) return undefined
  const parsed = value.flatMap(item => {
    const row = record(item)
    const stage = stringValue(row.stage)
    const durationMs = typeof row.durationMs === 'number' ? row.durationMs : Number.NaN
    if (!PI_INITIALIZATION_STAGE_VALUES.has(stage) || !Number.isFinite(durationMs)) return []
    return [{ stage: stage as NonNullable<PiLiveStateDto['initializationStage']>, durationMs: Math.max(0, durationMs) }]
  })
  return parsed.length ? parsed : undefined
}

function parseStartupResources(value: unknown): NonNullable<PiLiveStateDto['startupResources']> | undefined {
  const row = record(value)
  const list = (item: unknown, limit = 240) => Array.isArray(item)
    ? [...new Set(item.filter((entry): entry is string => typeof entry === 'string').map(entry => entry.trim()).filter(Boolean))].slice(0, limit)
    : []
  const resources: NonNullable<PiLiveStateDto['startupResources']> = {
    contexts: list(row.contexts),
    skills: list(row.skills),
    prompts: list(row.prompts),
    extensions: list(row.extensions),
    themes: list(row.themes),
    diagnostics: list(row.diagnostics, 80),
  }
  return Object.values(resources).some(items => items.length) ? resources : undefined
}

function mergeSnapshot(previous: PiLiveSnapshotDto | null, next: PiLiveSnapshotDto): PiLiveSnapshotDto {
  if (!previous) return next
  const entries = new Map<string, JsonValue>()
  let anonymous = 0
  for (const value of [...previous.entries, ...next.entries]) {
    const id = stringValue(record(value).id)
    entries.set(id || `anonymous-${anonymous++}`, value)
  }
  return {
    state: next.state,
    entries: [...entries.values()],
    leafId: next.leafId,
  }
}

function modelLabel(state: PiLiveStateDto | null): string {
  if (!state?.model) return 'Pi'
  const model = record(state.model)
  const provider = stringValue(model.provider)
  const id = stringValue(model.id || model.modelId || model.name)
  return [provider, id].filter(Boolean).join(' / ') || 'Pi'
}

function modelCompactLabel(state: PiLiveStateDto | null): string {
  if (!state?.model) return agentLensI18n.t('piLive:common.model')
  const model = record(state.model)
  return stringValue(model.name || model.id || model.modelId) || agentLensI18n.t('piLive:common.model')
}

function thinkingLevelSemanticKey(level: string): string {
  const normalized = level.trim().toLowerCase()
  if (normalized === 'minimal' || normalized === 'none' || normalized === 'off') return 'minimal'
  if (normalized === 'xhigh' || normalized === 'max' || normalized === 'maximum') return 'xhigh'
  return normalized
}

function thinkingLevelLabel(level: string): string {
  const normalized = thinkingLevelSemanticKey(level)
  if (normalized === 'minimal') return agentLensI18n.t('piLive:common.thinkingMinimal')
  if (normalized === 'low') return agentLensI18n.t('piLive:common.thinkingLow')
  if (normalized === 'medium') return agentLensI18n.t('piLive:common.thinkingMedium')
  if (normalized === 'high') return agentLensI18n.t('piLive:common.thinkingHigh')
  if (normalized === 'xhigh') return agentLensI18n.t('piLive:common.thinkingXHigh')
  return level
}

function modelSelection(state: PiLiveStateDto | null): string {
  if (!state?.model) return ''
  const model = record(state.model)
  const provider = stringValue(model.provider)
  const id = stringValue(model.id || model.modelId)
  return provider && id ? JSON.stringify([provider, id]) : ''
}

function currentLocale(): string {
  return agentLensI18n.resolvedLanguage ?? agentLensI18n.language ?? 'zh-CN'
}

function formatTaskDateTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return new Intl.DateTimeFormat(currentLocale(), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date)
}

function formatTaskDuration(ms: number): string {
  const value = Math.max(0, ms)
  if (value < 60_000) return agentLensI18n.t('piLive:common.seconds', { count: Math.floor(value / 1000) })
  if (value < 3_600_000) return agentLensI18n.t('piLive:common.minutes', { count: Math.floor(value / 60_000) })
  if (value < 86_400_000) return agentLensI18n.t('piLive:common.hoursMinutes', {
    hours: Math.floor(value / 3_600_000),
    minutes: Math.floor(value % 3_600_000 / 60_000),
  })
  return agentLensI18n.t('piLive:common.daysHours', {
    days: Math.floor(value / 86_400_000),
    hours: Math.floor(value % 86_400_000 / 3_600_000),
  })
}

function PiLiveElapsed({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const started = Date.parse(startedAt)
  return <>{Number.isFinite(started) ? formatTaskDuration(now - started) : '—'}</>
}

function parseModelSelection(value: string): { provider: string; modelId: string } | null {
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.length !== 2) return null
    const provider = stringValue(parsed[0])
    const modelId = stringValue(parsed[1])
    return provider && modelId ? { provider, modelId } : null
  } catch {
    return null
  }
}

function brief(value: unknown, max = 120): string {
  let text = ''
  if (typeof value === 'string') text = value
  else {
    try { text = JSON.stringify(value) } catch { text = String(value ?? '') }
  }
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function toolOutput(value: unknown): string {
  const result = record(value)
  const content = result.content
  if (Array.isArray(content)) {
    return content.map(item => {
      const row = record(item)
      return stringValue(row.text || row.content)
    }).filter(Boolean).join('\n')
  }
  return brief(value, 4000)
}

function assistantPartialContent(update: Record<string, unknown>, contentIndex: number | undefined): Record<string, unknown> {
  if (contentIndex === undefined) return {}
  const partial = record(update.partial)
  const content = Array.isArray(partial.content) ? partial.content : []
  return record(content[contentIndex])
}

function extensionRequest(event: Record<string, unknown>): ExtensionRequest | null {
  if (event.type !== 'extension_ui_request') return null
  const id = stringValue(event.id)
  const method = stringValue(event.method)
  if (!id || !['select', 'confirm', 'input', 'editor'].includes(method)) return null
  return {
    id,
    method,
    title: stringValue(event.title) || agentLensI18n.t('piLive:common.confirmationTitle'),
    message: stringValue(event.message),
    options: Array.isArray(event.options) ? event.options.filter((item): item is string => typeof item === 'string') : [],
    placeholder: stringValue(event.placeholder),
    prefill: stringValue(event.prefill),
  }
}

function PiLiveStart({ known }: { known: PiLiveStateDto[] }) {
  const { t } = useTranslation('piLive')
  const navigate = useNavigate()
  const [cwd, setCwd] = useState(() => {
    try { return localStorage.getItem('agent-lens:pi-live-last-cwd') ?? '' } catch { return '' }
  })
  const [model, setModel] = useState('')
  const [provider, setProvider] = useState('')
  const [availability, setAvailability] = useState<string>(() => t('start.checking'))
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    void piLiveApi.availability().then(value => {
      if (cancelled) return
      setAvailability(value.available ? t('start.ready', { executable: value.executable ?? 'PATH' }) : t('start.unavailable', { reason: value.reason ?? t('start.executableMissing') }))
    }, reason => {
      if (!cancelled) setAvailability(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { cancelled = true }
  }, [t])

  const start = async () => {
    if (!cwd.trim() || starting) return
    setStarting(true)
    setError('')
    try {
      const state = await piLiveApi.start({
        cwd: cwd.trim(),
        ...(provider.trim() ? { provider: provider.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        name: 'AgentLens Pi Live',
      })
      try { localStorage.setItem('agent-lens:pi-live-last-cwd', cwd.trim()) } catch { /* ignore */ }
      navigate(`/review/live/${encodeURIComponent(state.runtimeSessionId)}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setStarting(false)
    }
  }

  return <main className="pi-live-start-page">
    <section className="pi-live-start-card">
      <div className="pi-live-start-kicker">{t('start.kicker')}</div>
      <h1>{t('start.title')}</h1>
      <p>{t('start.description')}</p>
      <label>{t('start.cwd')}<Input value={cwd} onChange={event => setCwd(event.target.value)} placeholder={t('start.cwdPlaceholder')} autoFocus/></label>
      <Disclosure summary={t('start.modelSettings')} className="pi-live-start-model-settings">
        <div className="pi-live-start-grid">
          <label>Provider<Input value={provider} onChange={event => setProvider(event.target.value)} placeholder={t('start.providerPlaceholder')}/></label>
          <label>Model<Input value={model} onChange={event => setModel(event.target.value)} placeholder={t('start.modelPlaceholder')}/></label>
        </div>
      </Disclosure>
      <div className="pi-live-start-status">{availability}</div>
      {error && <div className="pi-live-error" role="alert">{error}</div>}
      <div className="pi-live-start-actions">
        <Button onClick={() => navigate('/review')}>{t('start.back')}</Button>
        <Button variant="primary" loading={starting} disabled={!cwd.trim()} onClick={() => void start()}>{t('start.launch')}</Button>
      </div>
    </section>
    {known.length > 0 && <section className="pi-live-known-card">
      <div><b>{t('start.backgroundTitle')}</b><span>{t('start.backgroundDescription')}</span></div>
      {known.map(item => <button key={item.runtimeSessionId} onClick={() => navigate(`/review/live/${encodeURIComponent(item.runtimeSessionId)}`)}>
        <span>{piLiveSessionTitle(item)}</span>
        <small>{modelLabel(item)} · {item.status === 'initializing' ? t('start.initializing') : item.status === 'failed' ? t('start.failed') : item.isStreaming ? t('start.working') : t('start.waiting')}</small>
      </button>)}
    </section>}
  </main>
}

function ExtensionPrompt({ request, onAnswer }: { request: ExtensionRequest; onAnswer(value: JsonValue): void }) {
  const { t } = useTranslation('piLive')
  const [value, setValue] = useState(request.prefill)
  useEffect(() => setValue(request.prefill), [request.id, request.prefill])

  if (request.method === 'confirm') {
    return <div className="pi-live-blocking" role="dialog" aria-label={request.title}>
      <div><b>{request.title}</b>{request.message && <span>{request.message}</span>}</div>
      <div className="pi-live-blocking-actions"><Button size="small" onClick={() => onAnswer({ confirmed: false })}>{t('blocking.reject')}</Button><Button size="small" variant="primary" onClick={() => onAnswer({ confirmed: true })}>{t('blocking.allow')}</Button></div>
    </div>
  }
  if (request.method === 'select') {
    return <div className="pi-live-blocking" role="dialog" aria-label={request.title}>
      <div><b>{request.title}</b>{request.message && <span>{request.message}</span>}</div>
      <div className="pi-live-blocking-options">{request.options.map(option => <Button size="small" key={option} onClick={() => onAnswer({ value: option })}>{option}</Button>)}<Button size="small" onClick={() => onAnswer({ cancelled: true })}>{t('blocking.cancel')}</Button></div>
    </div>
  }
  return <div className="pi-live-blocking pi-live-blocking-input" role="dialog" aria-label={request.title}>
    <div><b>{request.title}</b>{request.message && <span>{request.message}</span>}</div>
    {request.method === 'editor'
      ? <Textarea className="pi-live-blocking-field" value={value} onChange={event => setValue(event.target.value)} placeholder={request.placeholder}/>
      : <Input className="pi-live-blocking-field" value={value} onChange={event => setValue(event.target.value)} placeholder={request.placeholder}/>}
    <div className="pi-live-blocking-actions"><Button size="small" onClick={() => onAnswer({ cancelled: true })}>{t('blocking.cancel')}</Button><Button size="small" variant="primary" onClick={() => onAnswer({ value })}>{t('blocking.submit')}</Button></div>
  </div>
}

export function PiLivePage({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation('piLive')
  const navigate = useNavigate()
  const { runtimeSessionId } = useParams()
  const runtimeId = runtimeSessionId ? decodeURIComponent(runtimeSessionId) : ''
  const readerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<PiMarkdownComposerHandle>(null)
  const followingRef = useRef(true)
  const followFrameRef = useRef<number | null>(null)
  const leafIdRef = useRef<string | undefined>(undefined)
  const assistantMessageEpochRef = useRef(0)
  const startupSendingRef = useRef(false)
  const activePromptRef = useRef('')
  const [known, setKnown] = useState<PiLiveStateDto[]>([])
  const [snapshot, setSnapshot] = useState<PiLiveSnapshotDto | null>(null)
  const [state, setState] = useState<PiLiveStateDto | null>(null)
  const [controls, setControls] = useState<PiLiveControlsDto>({ models: [], thinkingLevels: [] })
  const [connected, setConnected] = useState(false)
  const [mode, setMode] = useState<QueueMode>('steer')
  const [input, setInput] = useState('')
  const [composerExpanded, setComposerExpanded] = useState(false)
  const [startupQueued, setStartupQueued] = useState('')
  const [optimisticPrompt, setOptimisticPrompt] = useState('')
  const [currentOrdinal, setCurrentOrdinal] = useState<number | null>(null)
  const [currentItems, setCurrentItems] = useState<PiLiveHistoryItem[]>([])
  const [queue, setQueue] = useState<PiLiveQueueDto>({ steering: [], followUp: [] })
  const [pendingQueue, setPendingQueue] = useState<PendingQueueSubmission[]>([])
  const [restored, setRestored] = useState<RestoredDraft[]>([])
  const [extension, setExtension] = useState<ExtensionRequest | null>(null)
  const [extensionPending, setExtensionPending] = useState(false)
  const [controlBusy, setControlBusy] = useState(false)
  const [diagnostics, setDiagnostics] = useState<PiLiveTransportDiagnostics | null>(null)
  const [newRecords, setNewRecords] = useState(false)
  const [interruptNotice, setInterruptNotice] = useState(false)
  const [showAllEvents, setShowAllEvents] = useState(true)
  const [error, setError] = useState('')
  const [syncWarningCode, setSyncWarningCode] = useState<'' | 'controls-refresh-failed' | 'history-reconcile-failed' | 'snapshot-sync-failed'>('')
  const [busy, setBusy] = useState(false)
  const [sendPending, setSendPending] = useState(false)
  const [abortPending, setAbortPending] = useState(false)
  const [queueMutationPending, setQueueMutationPending] = useState(false)

  useEffect(() => {
    let cancelled = false
    void piLiveApi.knownRuntimes().then(value => { if (!cancelled) setKnown(value) }, () => undefined)
    return () => { cancelled = true }
  }, [runtimeId])

  useEffect(() => {
    if (!interruptNotice) return
    const timeout = window.setTimeout(() => setInterruptNotice(false), 2800)
    return () => window.clearTimeout(timeout)
  }, [interruptNotice])

  useEffect(() => {
    if (!runtimeId) return
    let active = true
    if (followFrameRef.current !== null) {
      cancelAnimationFrame(followFrameRef.current)
      followFrameRef.current = null
    }
    setSnapshot(null)
    setState(null)
    setControls({ models: [], thinkingLevels: [] })
    setOptimisticPrompt('')
    setCurrentOrdinal(null)
    setCurrentItems([])
    setQueue({ steering: [], followUp: [] })
    setPendingQueue([])
    setRestored([])
    setExtension(null)
    setError('')
    setSyncWarningCode('')
    setInterruptNotice(false)
    setShowAllEvents(true)
    setStartupQueued('')
    setComposerExpanded(false)
    setQueueMutationPending(false)
    assistantMessageEpochRef.current = 0
    startupSendingRef.current = false
    activePromptRef.current = ''
    leafIdRef.current = undefined

    let controlsLoaded = false
    let controlsRefreshTask: Promise<void> | null = null
    let settlementRefreshTask: Promise<void> | null = null
    let settlementRefreshPending = false

    const refreshControls = (force = false): Promise<void> => {
      if (!force && controlsLoaded) return Promise.resolve()
      if (controlsRefreshTask) return controlsRefreshTask
      const task = piLiveApi.controls(runtimeId).then(value => {
        if (!active) return
        controlsLoaded = true
        setControls(value)
        setSyncWarningCode(current => current === 'controls-refresh-failed' ? '' : current)
      }).catch(reason => {
        if (!active) return
        const detail = reason instanceof Error ? reason.message : String(reason)
        console.warn('[AgentLens] Pi Live controls refresh failed:', detail)
        setSyncWarningCode('controls-refresh-failed')
      }).finally(() => {
        if (controlsRefreshTask === task) controlsRefreshTask = null
      })
      controlsRefreshTask = task
      return task
    }

    const acceptSnapshot = (value: PiLiveSnapshotDto) => {
      if (!active || value.state.runtimeSessionId !== runtimeId) return
      setSnapshot(current => mergeSnapshot(current, value))
      setState(value.state)
      leafIdRef.current = value.leafId ?? undefined
      if (value.state.isStreaming) {
        const projected = projectPiLiveTaskRounds(projectPiLiveHistory(value))
        const latest = [...projected].reverse().find(round => round.model.ordinal !== undefined)
        if (latest?.model.ordinal !== undefined) {
          const ordinal = latest.model.ordinal
          const roundItems = projected.filter(round => round.model.ordinal === ordinal).flatMap(round => round.items)
          const prompt = roundItems.find(item => item.kind === 'message' && item.role === 'user')
          const promptText = prompt?.kind === 'message' ? prompt.text : ''
          const persisted = omitPiLivePromptMessages(roundItems, promptText)
          setCurrentOrdinal(ordinal)
          setOptimisticPrompt(promptText)
          activePromptRef.current = promptText
          setCurrentItems(current => markPiLiveItemsRunning(current.length ? reconcilePiLiveItems(current, persisted) : persisted))
        }
      }
      window.dispatchEvent(new Event('agent-lens:pi-live-state-changed'))
    }

    const reconcileSettledSnapshot = async () => {
      try {
        const value = await piLiveApi.snapshot(runtimeId, leafIdRef.current)
        if (!active) return
        const prompt = activePromptRef.current.trim()
        const freshHistory = projectPiLiveHistory(value)
        const freshRounds = projectPiLiveTaskRounds(freshHistory)
        const ordinal = prompt
          ? [...freshRounds].reverse().find(round => round.model.ordinal !== undefined && round.items.some(item => item.kind === 'message' && item.role === 'user' && item.text.trim() === prompt))?.model.ordinal ?? null
          : [...freshRounds].reverse().find(round => round.model.ordinal !== undefined)?.model.ordinal ?? null
        const settledItems = ordinal === null
          ? []
          : freshRounds.filter(round => round.model.ordinal === ordinal).flatMap(round => round.items)
        const resolvedPromptItem = settledItems.find(item => item.kind === 'message' && item.role === 'user')
        const resolvedPrompt = prompt || (resolvedPromptItem?.kind === 'message' ? resolvedPromptItem.text : '')
        acceptSnapshot(value)
        if (ordinal !== null && settledItems.length > 0) {
          setCurrentOrdinal(ordinal)
          setCurrentItems(current => reconcilePiLiveItems(current, omitPiLivePromptMessages(settledItems, resolvedPrompt)))
          setOptimisticPrompt(resolvedPrompt)
        }
        activePromptRef.current = ''
        setSyncWarningCode(current => current === 'history-reconcile-failed' ? '' : current)
      } catch (reason) {
        if (!active) return
        const detail = reason instanceof Error ? reason.message : String(reason)
        console.warn('[AgentLens] Pi Live settled snapshot reconciliation failed:', detail)
        setCurrentItems(current => settlePiLiveItems(current))
        setSyncWarningCode('history-reconcile-failed')
      }
    }

    const refreshAfterSettled = (): Promise<void> => {
      if (settlementRefreshTask) {
        settlementRefreshPending = true
        return settlementRefreshTask
      }
      const task = (async () => {
        do {
          settlementRefreshPending = false
          await reconcileSettledSnapshot()
        } while (active && settlementRefreshPending)
      })().finally(() => {
        if (settlementRefreshTask === task) settlementRefreshTask = null
      })
      settlementRefreshTask = task
      return task
    }

    const dispose = piLiveApi.connect(runtimeId, {
      onConnection: value => { if (active) setConnected(value) },
      onSnapshot: value => {
        acceptSnapshot(value)
        if (value.state.status === 'ready') void refreshControls()
      },
      onError: reason => {
        if (!active) return
        if (reason instanceof PiLiveRequestError && reason.status === 502) {
          setSyncWarningCode('snapshot-sync-failed')
          return
        }
        setError(reason.message)
      },
      onEvents(events, nextDiagnostics) {
        if (!active) return
        let settled = false
        let controlsChanged = false
        let statePatch: Partial<PiLiveStateDto> = {}
        for (const wrapper of events) {
          const event = record(wrapper.event)
          const type = stringValue(event.type)
          if (type === 'agent_start') {
            statePatch = { ...statePatch, isStreaming: true }
            setCurrentItems([])
            if (!activePromptRef.current) {
              setCurrentOrdinal(null)
              setOptimisticPrompt('')
            }
          } else if (type === 'agent_settled') {
            statePatch = { ...statePatch, isStreaming: false, pendingMessageCount: 0 }
            setCurrentItems(current => settlePiLiveItems(current))
            settled = true
          } else if (type === 'message_start') {
            const message = record(event.message)
            if (message.role === 'assistant') assistantMessageEpochRef.current += 1
          } else if (type === 'compaction_start') {
            statePatch = { ...statePatch, isCompacting: true }
          } else if (type === 'compaction_end') {
            statePatch = { ...statePatch, isCompacting: false }
          } else if (type === 'model_changed' || type === 'thinking_level_changed') {
            controlsChanged = true
          } else if (type === 'message_update') {
            const update = record(event.assistantMessageEvent)
            const delta = stringValue(update.delta)
            const contentIndex = typeof update.contentIndex === 'number' ? update.contentIndex : undefined
            const block = assistantPartialContent(update, contentIndex)
            const deltaOptions = {
              messageEpoch: assistantMessageEpochRef.current,
              ...(contentIndex === undefined ? {} : { contentIndex }),
            }
            if (update.type === 'text_start') {
              setCurrentItems(items => startPiLiveContentBlock(items, 'text', deltaOptions, stringValue(block.text)))
            } else if (update.type === 'text_delta' && delta) {
              setCurrentItems(items => appendPiLiveDelta(items, 'text', delta, deltaOptions))
            } else if (update.type === 'text_end') {
              const content = stringValue(update.content) || stringValue(block.text)
              setCurrentItems(items => finishPiLiveContentBlock(items, 'text', content, deltaOptions))
            } else if (update.type === 'thinking_start') {
              setCurrentItems(items => startPiLiveContentBlock(items, 'thinking', deltaOptions, stringValue(block.thinking || block.text)))
            } else if (update.type === 'thinking_delta' && delta) {
              setCurrentItems(items => appendPiLiveDelta(items, 'thinking', delta, deltaOptions))
            } else if (update.type === 'thinking_end') {
              const content = stringValue(update.content) || stringValue(block.thinking || block.text)
              setCurrentItems(items => finishPiLiveContentBlock(items, 'thinking', content, deltaOptions))
            } else if (update.type === 'toolcall_start' || update.type === 'toolcall_delta' || update.type === 'toolcall_end') {
              const completed = record(update.toolCall)
              const toolCall = Object.keys(completed).length ? completed : block
              const callId = stringValue(update.id || update.toolCallId || toolCall.id)
              if (callId) {
                const args = toolCall.arguments ?? toolCall.args ?? update.arguments ?? update.args
                setCurrentItems(items => startPiLiveTool(items, {
                  callId,
                  name: stringValue(update.toolName || update.name || toolCall.name) || 'tool',
                  summary: args === undefined ? '' : brief(args),
                  ...(contentIndex === undefined ? {} : { contentIndex }),
                }))
              }
            }
          } else if (type === 'message_end') {
            // 最终消息由 agent_settled Snapshot 对账；这里不重排或替换已经展示的 block。
          } else if (type === 'tool_execution_start') {
            const id = stringValue(event.toolCallId)
            if (id) setCurrentItems(items => startPiLiveTool(items, {
              callId: id,
              name: stringValue(event.toolName) || 'tool',
              summary: brief(event.args),
              startedAtMs: Date.now(),
            }))
          } else if (type === 'tool_execution_update') {
            const id = stringValue(event.toolCallId)
            if (id) setCurrentItems(items => updatePiLiveTool(items, id, toolOutput(event.partialResult)))
          } else if (type === 'tool_execution_end') {
            const id = stringValue(event.toolCallId)
            if (id) setCurrentItems(items => finishPiLiveTool(
              items,
              id,
              event.isError === true ? 'error' : 'success',
              toolOutput(event.result),
            ))
          } else if (type === 'queue_update') {
            const steering = Array.isArray(event.steering) ? event.steering.filter((item): item is string => typeof item === 'string') : []
            const followUp = Array.isArray(event.followUp) ? event.followUp.filter((item): item is string => typeof item === 'string') : []
            setQueue({ steering, followUp })
            setPendingQueue(current => current.filter(item => !(item.mode === 'steer' ? steering : followUp).includes(item.text)))
            statePatch = { ...statePatch, pendingMessageCount: steering.length + followUp.length }
          } else if (type === 'runtime_resources') {
            const startupResources = parseStartupResources(event.resources)
            if (startupResources) statePatch = { ...statePatch, startupResources }
          } else if (type === 'runtime_output') {
            const message = stringValue(event.message).trim()
            if (message) {
              setState(current => current ? { ...current, startupOutput: [...(current.startupOutput ?? []), message].slice(-80) } : current)
            }
          } else if (type === 'task_summary') {
            const summary = stringValue(event.taskSummary).trim()
            if (summary) {
              statePatch = { ...statePatch, taskSummary: summary }
              window.dispatchEvent(new Event('agent-lens:pi-live-state-changed'))
            }
          } else if (type === 'runtime_initialization' || type === 'runtime_status') {
            const status = stringValue(event.status)
            const initializationStage = stringValue(event.stage)
            const initializationMessage = stringValue(event.message)
            const runtimeError = stringValue(event.error)
            const initializationElapsedMs = typeof event.elapsedMs === 'number' ? event.elapsedMs : typeof event.initializationElapsedMs === 'number' ? event.initializationElapsedMs : undefined
            const initializationTimings = parseInitializationTimings(event.timings ?? event.initializationTimings)
            statePatch = {
              ...statePatch,
              ...(status ? { status: status as PiLiveStateDto['status'] } : {}),
              ...(initializationStage ? { initializationStage: initializationStage as PiLiveStateDto['initializationStage'] } : {}),
              ...(initializationMessage ? { initializationMessage } : {}),
              ...(initializationElapsedMs !== undefined ? { initializationElapsedMs } : {}),
              ...(initializationTimings ? { initializationTimings } : {}),
              ...(runtimeError ? { error: runtimeError } : {}),
            }
            if (runtimeError) setError(runtimeError)
            window.dispatchEvent(new Event('agent-lens:pi-live-state-changed'))
            if (status === 'ready') {
              void piLiveApi.snapshot(runtimeId, leafIdRef.current).then(acceptSnapshot, reason => {
                const detail = reason instanceof Error ? reason.message : String(reason)
                console.warn('[AgentLens] Pi Live ready snapshot refresh failed:', detail)
                if (active) setSyncWarningCode('snapshot-sync-failed')
              })
              void refreshControls()
            }
          } else {
            const request = extensionRequest(event)
            if (request) setExtension(request)
            if (type === 'extension_error') setError(stringValue(event.error) || agentLensI18n.t('piLive:warning.extensionFailed'))
            if (type === 'runtime_exit') {
              setError(stringValue(event.errorMessage) || agentLensI18n.t('piLive:warning.runtimeExited'))
              statePatch = { ...statePatch, isStreaming: false, isCompacting: false }
            }
          }
        }
        if (Object.keys(statePatch).length) setState(current => current ? { ...current, ...statePatch } : current)
        setDiagnostics(nextDiagnostics)
        if (!followingRef.current) setNewRecords(true)
        if (settled) void refreshAfterSettled()
        if (controlsChanged) {
          void piLiveApi.state(runtimeId).then(value => {
            if (!active) return
            setState(value)
            if (value.status === 'ready') void refreshControls(true)
          }, () => undefined)
        }
      },
    })
    return () => {
      active = false
      dispose()
      if (followFrameRef.current !== null) {
        cancelAnimationFrame(followFrameRef.current)
        followFrameRef.current = null
      }
    }
  }, [runtimeId])

  const history = useMemo(() => projectPiLiveHistory(snapshot), [snapshot])
  const historyRounds = useMemo(() => projectPiLiveTaskRounds(history), [history])
  const visibleHistoryRounds = useMemo(() => currentOrdinal === null
    ? historyRounds
    : historyRounds.filter(round => round.model.ordinal !== currentOrdinal), [currentOrdinal, historyRounds])
  const optimisticStreaming = ((Boolean(optimisticPrompt) && currentOrdinal === null && state?.isStreaming !== false) || (state?.isStreaming ?? false))
  const visiblePendingCount = queue.steering.length + queue.followUp.length + pendingQueue.length
  const runningRound = useMemo(() => {
    if (currentOrdinal !== null) {
      const settledProjection = historyRounds.find(round => round.model.ordinal === currentOrdinal && !round.continuation)
      if (settledProjection && !optimisticStreaming) return { ...settledProjection.model, id: 'pi-live-current-round' }
    }
    if (!optimisticPrompt && !state?.isStreaming && currentItems.length === 0) return undefined
    return projectPiLiveRunningRound({ items: currentItems, isStreaming: optimisticStreaming })
  }, [currentItems, currentOrdinal, historyRounds, optimisticPrompt, optimisticStreaming, state?.isStreaming])
  const taskDetailModel = useMemo(() => projectPiLiveTaskDetail({
    state: state ? { ...state, pendingMessageCount: visiblePendingCount } : state,
    connected,
    historyRounds,
    runningRound,
  }), [connected, historyRounds, runningRound, state, visiblePendingCount])
  const headerTitle = taskDetailModel.title

  const beginOptimisticPrompt = useCallback((text: string) => {
    setInterruptNotice(false)
    setCurrentOrdinal(null)
    setCurrentItems([])
    activePromptRef.current = text
    setOptimisticPrompt(text)
    setState(current => current ? { ...current, isStreaming: true } : current)
  }, [])

  const rollbackOptimisticPrompt = useCallback((text: string) => {
    if (activePromptRef.current !== text) return
    activePromptRef.current = ''
    setOptimisticPrompt('')
    setCurrentItems([])
    setState(current => current ? { ...current, isStreaming: false } : current)
  }, [])

  useEffect(() => {
    if (!followingRef.current || followFrameRef.current !== null) return
    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = null
      const reader = readerRef.current
      if (!reader || !followingRef.current) return
      const target = Math.max(0, reader.scrollHeight - reader.clientHeight)
      if (Math.abs(reader.scrollTop - target) > 1) reader.scrollTop = target
    })
  }, [visibleHistoryRounds, currentItems, optimisticPrompt, queue.steering.length, queue.followUp.length, restored, extension?.id])

  // 初始化阶段先接住第一条任务；Worker ready 后只发送一次，失败则还原为可编辑草稿。
  useEffect(() => {
    if (!runtimeId || state?.status !== 'ready' || !startupQueued || startupSendingRef.current) return
    const text = startupQueued
    startupSendingRef.current = true
    setBusy(true)
    setError('')
    setStartupQueued(current => current === text ? '' : current)
    beginOptimisticPrompt(text)
    inputRef.current?.focus({ preventScroll: true })
    void piLiveApi.prompt(runtimeId, text).then(() => {
      inputRef.current?.focus({ preventScroll: true })
    }, reason => {
      rollbackOptimisticPrompt(text)
      setInput(current => current || text)
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      startupSendingRef.current = false
      setBusy(false)
    })
  }, [beginOptimisticPrompt, rollbackOptimisticPrompt, runtimeId, startupQueued, state?.status])

  if (!runtimeId) return <PiLiveStart known={known}/>

  const send = async (forcedMode?: QueueMode) => {
    const text = input.trim()
    if (!text || sendPending || queueMutationPending || extension) return
    if (!runtimeReady) {
      if (!canStageStartup) return
      setStartupQueued(text)
      setInput('')
      inputRef.current?.focus({ preventScroll: true })
      return
    }
    if (startupQueued) return
    const wasStreaming = state?.isStreaming ?? false
    const selectedMode = forcedMode ?? mode
    setSendPending(true)
    setError('')
    setInput('')
    if (!wasStreaming) beginOptimisticPrompt(text)
    const pending = wasStreaming ? { id: `pending-${Date.now()}`, mode: selectedMode, text } : null
    if (pending) setPendingQueue(current => [...current, pending])
    inputRef.current?.focus({ preventScroll: true })
    try {
      if (wasStreaming) {
        if (selectedMode === 'steer') await piLiveApi.steer(runtimeId, text)
        else await piLiveApi.followUp(runtimeId, text)
      } else {
        await piLiveApi.prompt(runtimeId, text)
      }
    } catch (reason) {
      setInput(current => current || text)
      if (!wasStreaming) rollbackOptimisticPrompt(text)
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (pending) setPendingQueue(current => current.filter(item => item.id !== pending.id))
      setSendPending(false)
    }
  }

  const changeModel = async (selection: string) => {
    const next = parseModelSelection(selection)
    if (!next || controlBusy) return
    setControlBusy(true)
    setError('')
    try {
      const nextState = await piLiveApi.setModel(runtimeId, next.provider, next.modelId)
      setState(nextState)
      setControls(await piLiveApi.controls(runtimeId))
      inputRef.current?.focus({ preventScroll: true })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setControlBusy(false)
    }
  }

  const changeThinkingLevel = async (level: string) => {
    if (!level || controlBusy) return
    setControlBusy(true)
    setError('')
    try {
      const nextState = await piLiveApi.setThinkingLevel(runtimeId, level)
      setState(nextState)
      inputRef.current?.focus({ preventScroll: true })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setControlBusy(false)
    }
  }

  const stop = useCallback(async () => {
    if (!optimisticStreaming || abortPending || queueMutationPending) return
    setAbortPending(true)
    setError('')
    try {
      const pending = await piLiveApi.abort(runtimeId, true)
      const drafts: RestoredDraft[] = [
        ...pending.steering.map((text, index) => ({ id: `steer-${Date.now()}-${index}`, mode: 'steer' as const, text })),
        ...pending.followUp.map((text, index) => ({ id: `follow-${Date.now()}-${index}`, mode: 'followUp' as const, text })),
      ]
      setRestored(drafts)
      setQueue({ steering: [], followUp: [] })
      setPendingQueue([])
      setState(current => current ? { ...current, isStreaming: false, pendingMessageCount: 0 } : current)
      setCurrentItems(items => reconcilePiLiveItems(items, []))
      setInterruptNotice(true)
      inputRef.current?.focus({ preventScroll: true })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setAbortPending(false)
    }
  }, [abortPending, optimisticStreaming, queueMutationPending, runtimeId])

  useEffect(() => {
    if (!optimisticStreaming) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      event.preventDefault()
      void stop()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [optimisticStreaming, stop])

  const removeQueued = async (queueMode: QueueMode, queueIndex: number, text: string) => {
    if (queueMutationPending) return
    setQueueMutationPending(true)
    setError('')
    try {
      const cleared = await piLiveApi.clearQueue(runtimeId)
      const steering = [...cleared.steering]
      const followUp = [...cleared.followUp]
      const target = queueMode === 'steer' ? steering : followUp
      const resolvedIndex = target[queueIndex] === text ? queueIndex : target.indexOf(text)
      if (resolvedIndex >= 0) target.splice(resolvedIndex, 1)

      setQueue({ steering: [], followUp: [] })
      for (const message of steering) await piLiveApi.steer(runtimeId, message)
      for (const message of followUp) await piLiveApi.followUp(runtimeId, message)
      setQueue({ steering, followUp })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setQueueMutationPending(false)
      inputRef.current?.focus({ preventScroll: true })
    }
  }

  const answerExtension = async (value: JsonValue) => {
    if (!extension || extensionPending) return
    setExtensionPending(true)
    try {
      await piLiveApi.extensionResponse(runtimeId, extension.id, value)
      setExtension(null)
      inputRef.current?.focus({ preventScroll: true })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setExtensionPending(false)
    }
  }

  const editRestored = (draft: RestoredDraft) => {
    setInput(draft.text)
    setMode(draft.mode)
    setRestored(items => items.filter(item => item.id !== draft.id))
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
  }

  const removeRestored = (id: string) => {
    setRestored(items => items.filter(item => item.id !== id))
    inputRef.current?.focus({ preventScroll: true })
  }

  const editStartupQueued = () => {
    if (!startupQueued) return
    setInput(startupQueued)
    setStartupQueued('')
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
  }

  const removeStartupQueued = () => {
    setStartupQueued('')
    inputRef.current?.focus({ preventScroll: true })
  }

  const onReaderScroll = () => {
    const reader = readerRef.current
    if (!reader) return
    followingRef.current = reader.scrollHeight - reader.scrollTop - reader.clientHeight < 140
    if (followingRef.current) setNewRecords(false)
  }

  const jumpLatest = () => {
    const reader = readerRef.current
    if (reader) reader.scrollTo({ top: reader.scrollHeight, behavior: 'auto' })
    followingRef.current = true
    setNewRecords(false)
    inputRef.current?.focus({ preventScroll: true })
  }

  const terminate = async () => {
    if (busy) return
    setBusy(true)
    try {
      await piLiveApi.terminate(runtimeId)
      navigate('/review/live')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setBusy(false)
    }
  }

  const retry = async () => {
    if (busy || state?.status !== 'failed') return
    setBusy(true)
    setError('')
    try {
      setState(await piLiveApi.retry(runtimeId))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const queueItems = [
    ...pendingQueue.map(item => ({ ...item, active: true, pending: true })),
    ...queue.steering.map((text, index) => ({ id: `active-steer-${index}`, mode: 'steer' as QueueMode, text, active: true, queueIndex: index })),
    ...queue.followUp.map((text, index) => ({ id: `active-follow-${index}`, mode: 'followUp' as QueueMode, text, active: true, queueIndex: index })),
    ...restored.map(item => ({ ...item, active: false })),
  ]
  const selectedModel = modelSelection(state)
  const runtimeReady = state?.status === 'ready'
  const runtimeInitializing = !state || state.status === 'initializing'
  const runtimeTerminating = state?.status === 'terminating'
  const canStageStartup = runtimeInitializing && !startupQueued
  const canSend = Boolean(input.trim()) && !sendPending && !queueMutationPending && !extension && !runtimeTerminating && (runtimeReady ? !startupQueued : canStageStartup)
  const syncWarning = syncWarningCode === 'controls-refresh-failed'
    ? t('warning.modelRefreshFailed')
    : syncWarningCode === 'history-reconcile-failed'
      ? t('warning.historyReconcileFailed')
      : syncWarningCode === 'snapshot-sync-failed'
        ? t('warning.snapshotFailed')
        : ''
  const thinkingOptions = (() => {
    const values = new Map<string, string>()
    for (const level of controls.thinkingLevels) {
      const key = thinkingLevelSemanticKey(level)
      if (!values.has(key) || level === state?.thinkingLevel) values.set(key, level)
    }
    return [...values.values()].map(level => ({ value: level, label: thinkingLevelLabel(level) }))
  })()
  const composerStatus = startupQueued
    ? { label: t('connection.queued'), color: 'var(--al-accent)', title: t('connection.queuedTitle') }
    : runtimeInitializing
      ? { label: t('connection.initializing'), color: 'var(--al-accent)', title: state?.initializationMessage || t('connection.initializingTitle') }
      : state?.status === 'failed'
        ? { label: t('connection.failed'), color: 'var(--al-danger)', title: state.error || error || t('connection.failedTitle') }
        : connected
          ? { label: t('connection.connected'), color: 'var(--al-success)', title: t('connection.connectedTitle') }
          : { label: t('connection.reconnecting'), color: 'var(--al-warning)', title: t('connection.reconnectingTitle') }
  const diagnosticsTitle = diagnostics
    ? t('connection.diagnostics', {
        events: diagnostics.ingressEvents,
        coalesced: diagnostics.coalescedEvents,
        queue: diagnostics.maxQueueDepth,
        latency: diagnostics.lastFlushLatencyMs.toFixed(1),
        background: diagnostics.hidden ? t('connection.backgroundThrottled') : '',
      })
    : ''
  const inputPlaceholder = runtimeInitializing
    ? t('connection.composerInitializing')
    : state?.isStreaming ? t('connection.composerSteer') : t('connection.composerIdle')
  const startupState = state && ['initializing', 'ready', 'failed'].includes(state.status) ? state : null
  const startupMeta = startupState ? piStartupSummary(startupState) : null
  const hasBackgroundRound = visibleHistoryRounds.some(projection => projection.model.id === 'background:0')
  const startupSummaryMeta = startupMeta ? <span>{startupMeta.label} · {startupMeta.duration}</span> : undefined
  const startupContent = startupState ? <PiStartupDisclosure
    state={startupState}
    busy={busy}
    fallbackError={error}
    onRetry={() => void retry()}
    onTerminate={() => void terminate()}
    embedded
    showAllEvents={showAllEvents}
  /> : undefined

  return <main className={`pi-live-page ${embedded ? 'pi-live-page-embedded' : ''}`}>
    {!embedded && <aside className="pi-live-sessions">
      <div className="pi-live-sessions-head"><div><b>{t('sidebar.title')}</b><small>{t('sidebar.closeKeepsRunning')}</small></div><Button size="small" onClick={() => navigate('/review/live')}>{t('sidebar.newTask')}</Button></div>
      <div className="pi-live-session-scroll">
        {known.map(item => <button key={item.runtimeSessionId} className={`pi-live-session ${item.runtimeSessionId === runtimeId ? 'active' : ''}`} onClick={() => navigate(`/review/live/${encodeURIComponent(item.runtimeSessionId)}`)}>
          <div className="pi-live-session-top"><span className={item.isStreaming || item.status === 'initializing' ? 'pi-live-pulse' : 'pi-live-idle-dot'}/><span>Pi</span><span>{item.status === 'initializing' ? t('sidebar.starting') : item.status === 'failed' ? t('sidebar.failed') : item.isStreaming ? t('sidebar.live') : t('sidebar.idle')}</span></div>
          <div className="pi-live-session-title">{piLiveSessionTitle(item)}</div>
          <div className="pi-live-session-foot"><span>{modelLabel(item)}</span><span>PID {item.processId ?? '—'}</span></div>
        </button>)}
        {!known.length && <div className="pi-live-side-empty">{t('sidebar.empty')}</div>}
        <button className="pi-live-review-link" onClick={() => navigate('/review?source=pi')}>{t('sidebar.history')} <UiIcon name="arrow-right" size={14}/></button>
      </div>
    </aside>}

    <TaskSurface mode="live" className="pi-live-workspace">
      <TaskHeader
        marker={<span className="agent-icon source-pi" aria-hidden="true"><UiIcon name="agent" size={14}/></span>}
        agent={taskDetailModel.agentLabel}
        context={state?.projectName || workspaceDisplayName(state?.workspacePath) || t('header.noProject')}
        showStatus={false}
        title={<span title={headerTitle}>{brief(headerTitle, 15)}</span>}
        submeta={state?.gitBranch ? <span className="pi-live-header-branch" title={t('header.branchTitle', { branch: state.gitBranch })}>{t('header.branch', { branch: state.gitBranch })}</span> : undefined}
        metrics={[]}
        infoItems={state ? [
          { label: t('header.model'), value: taskDetailModel.contextLabel ?? t('header.defaultModel') },
          { label: t('header.project'), value: state.projectName ?? t('header.noProject') },
          ...(state.workspacePath ? [{ label: t('header.workspace'), value: <code title={state.workspacePath}>{state.workspacePath}</code> }] : []),
          ...(state.gitBranch ? [{ label: t('header.branchLabel'), value: state.gitBranch }] : []),
          ...(state.startedAt ? [
            { label: t('header.startTime'), value: formatTaskDateTime(state.startedAt) },
            { label: t('header.elapsed'), value: <PiLiveElapsed startedAt={state.startedAt}/> },
          ] : []),
          ...taskDetailModel.metrics.map(metric => ({ label: metric.label, value: metric.value, tone: metric.tone })),
        ] : []}
        actions={<>
          <Button size="small" className="review-audit-toggle" aria-pressed={showAllEvents} onClick={() => setShowAllEvents(value => !value)}>{showAllEvents ? t('header.viewAll') : t('header.viewCore')}</Button>
          {optimisticStreaming && <Button size="small" variant="danger" className="pi-live-stop" disabled={abortPending || queueMutationPending} onClick={() => void stop()}>{abortPending ? t('header.interrupting') : t('header.interrupt')}</Button>}
          <PiRuntimeMenu busy={busy} onTerminate={() => { void terminate() }}/>
        </>}
      />

      <div ref={readerRef} className="pi-live-reader" onScroll={onReaderScroll}>
        <div className="pi-live-document">
          {!state && <div className="pi-live-startup-spotlight"><OperationProgress
            statusLabel={t('loading.status')}
            title={t('loading.title')}
            description={t('loading.description')}
          /></div>}
          {startupState && startupState.status !== 'ready' && <div className="pi-live-startup-spotlight">{startupContent}</div>}
          {startupState?.status === 'ready' && !hasBackgroundRound && <PiLiveHistoryTaskRound
            projection={piLiveStartupBackground()}
            showAllEvents={showAllEvents}
            beforeContent={startupContent}
            summaryMeta={startupSummaryMeta}
          />}
          {visibleHistoryRounds.map((projection, index) => {
            const carriesStartup = Boolean(startupState?.status === 'ready' && projection.model.id === 'background:0')
            return <VirtualRoundMount
              key={projection.model.id}
              rootSelector=".pi-live-reader"
              flowRoot
              eager={carriesStartup || index >= visibleHistoryRounds.length - PI_LIVE_EAGER_CHUNKS}
              estimate={piLiveTaskRoundEstimate(projection) + (carriesStartup ? 230 : 0)}
            >
              <PiLiveHistoryTaskRound
                projection={projection}
                showAllEvents={showAllEvents}
                beforeContent={carriesStartup ? startupContent : undefined}
                summaryMeta={carriesStartup ? startupSummaryMeta : undefined}
              />
            </VirtualRoundMount>
          })}

          {runningRound && <PiLiveCurrentTaskRound
            model={runningRound}
            {...(optimisticPrompt ? { promptText: optimisticPrompt } : {})}
            items={currentItems}
            showAllEvents={showAllEvents}
            pendingMessageCount={visiblePendingCount}
          />}
          {!history.length && !optimisticPrompt && !currentItems.length && runtimeReady && <div className="pi-live-empty">{t('empty')}</div>}
          {error && <div className="pi-live-error pi-live-reader-error" role="alert">{error}</div>}
        </div>
      </div>

      <div className="pi-live-compose-wrap">
        <div className="pi-live-float-stack">
          {syncWarning && <div className="pi-live-sync-warning" role="status" aria-live="polite">{syncWarning}</div>}
          {newRecords && <Button size="small" className="pi-live-new-records" onClick={jumpLatest}>{t('newRecords')} <UiIcon name="arrow-down" size={14}/></Button>}
          {interruptNotice && <div className="pi-live-interrupt-notice" role="status" aria-live="polite"><UiIcon name="check" size={14}/><b>{t('interruptedTitle')}</b><span>{t('interruptedDescription')}</span></div>}
          {startupQueued && <div className="pi-live-startup-queue" role="status">
            <span>{t('queue.waitingReady')}</span><b>{startupQueued}</b><div><Button size="small" className="pi-live-queue-action" onClick={editStartupQueued}>{t('queue.edit')}</Button><Button size="small" className="pi-live-queue-action" onClick={removeStartupQueued}>{t('queue.withdraw')}</Button></div>
          </div>}
          {queueItems.length > 0 && <div className="pi-live-queue" role="status" aria-live="polite">{queueItems.map(item => <div key={item.id} className={`pi-live-queue-item ${item.active ? 'active' : 'restored'}`}>
            <span>{item.mode === 'steer' ? t('queue.steer') : t('queue.followUp')}</span><b>{item.text}</b>
            {item.active
              ? ('pending' in item && item.pending
                  ? <small>{t('queue.joining')}</small>
                  : <div><small>{t('queue.queued')}</small>{'queueIndex' in item && typeof item.queueIndex === 'number' && <Button size="small" className="pi-live-queue-action" disabled={queueMutationPending} onClick={() => void removeQueued(item.mode, Number(item.queueIndex), item.text)}>{t('queue.withdraw')}</Button>}</div>)
              : <div><Button size="small" className="pi-live-queue-action" onClick={() => editRestored(item)}>{t('queue.edit')}</Button><Button size="small" className="pi-live-queue-action" onClick={() => removeRestored(item.id)}>{t('queue.withdraw')}</Button></div>}
          </div>)}</div>}
          {extension && <ExtensionPrompt request={extension} onAnswer={value => { if (!extensionPending) void answerExtension(value) }}/>} 
        </div>
        <div className={`pi-live-composer ${composerExpanded ? 'is-expanded' : ''}`}>
          <div className="pi-live-editor">
            <div className="pi-live-editor-toolbar" aria-label={t('composer.toolbarAria')}>
              <IconButton
                className="pi-live-editor-action"
                title={composerExpanded ? t('composer.shrink') : t('composer.expand')}
                aria-label={composerExpanded ? t('composer.shrink') : t('composer.expand')}
                onClick={() => setComposerExpanded(value => !value)}
              ><UiIcon name={composerExpanded ? 'collapse' : 'expand'} size={16}/></IconButton>
            </div>
            <PiMarkdownComposer
              ref={inputRef}
              value={input}
              onChange={setInput}
              canSubmit={canSend}
              onSubmit={submitMode => void send(submitMode === 'followUp' ? 'followUp' : undefined)}
              onEscape={optimisticStreaming ? () => void stop() : undefined}
              placeholder={inputPlaceholder}
              title={t('composer.markdownHint')}
              ariaLabel={t('composer.inputAria')}
              disabled={runtimeTerminating}
            />
          </div>
          <div className="pi-live-compose-bar">
            <span className="pi-live-compose-runtime" title={[composerStatus.title, diagnosticsTitle].filter(Boolean).join(' · ')}>
              <span className="pi-live-idle-dot" aria-hidden="true" style={{ background: composerStatus.color, borderColor: composerStatus.color }}/>
              {composerStatus.label}
            </span>
            <div className="pi-live-compose-settings">
              <ComposerPillSelect
                ariaLabel={t('composer.modelAria')}
                title={state?.model ? t('composer.modelTitle', { model: modelLabel(state) }) : t('composer.modelGenericTitle')}
                value={selectedModel}
                placeholder={modelCompactLabel(state)}
                className="pi-live-model-picker"
                menuWidth={280}
                disabled={!runtimeReady || controlBusy || controls.models.length === 0}
                options={controls.models.map(item => ({
                  value: JSON.stringify([item.provider, item.id]),
                  label: item.name || item.id,
                  description: item.name && item.name !== item.id ? `${item.provider} · ${item.id}` : item.provider,
                }))}
                onChange={selection => void changeModel(selection)}
              />
              <ComposerPillSelect
                ariaLabel={t('composer.thinkingAria')}
                title={t('composer.thinkingTitle', { level: state?.thinkingLevel ? thinkingLevelLabel(state.thinkingLevel) : t('composer.thinkingUnset') })}
                value={state?.thinkingLevel ?? ''}
                placeholder={state?.thinkingLevel ? thinkingLevelLabel(state.thinkingLevel) : t('composer.thinkingPlaceholder')}
                className="pi-live-thinking-picker"
                menuWidth={168}
                disabled={!runtimeReady || controlBusy || controls.thinkingLevels.length === 0}
                options={thinkingOptions}
                onChange={level => void changeThinkingLevel(level)}
              />
            </div>
            <div className="pi-live-compose-mode" aria-label={t('composer.modeAria')}>
              <Button size="small" className={`pi-live-mode-action ${mode === 'steer' ? 'active' : ''}`} title={t('composer.steerTitle')} aria-pressed={mode === 'steer'} onClick={() => { setMode('steer'); requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true })) }}>{t('composer.steer')}</Button>
              <Button size="small" className={`pi-live-mode-action ${mode === 'followUp' ? 'active' : ''}`} title={t('composer.followUpTitle')} aria-pressed={mode === 'followUp'} onClick={() => { setMode('followUp'); requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true })) }}>{t('composer.followUp')}</Button>
            </div>
            <IconButton variant="primary" className="pi-live-send" disabled={!canSend} onClick={() => void send()} aria-label={runtimeReady ? t('composer.send') : t('composer.sendWhenReady')}><UiIcon name="send" size={20}/></IconButton>
          </div>
        </div>
      </div>
    </TaskSurface>
  </main>
}
