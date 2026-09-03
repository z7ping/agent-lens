import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { JsonValue, PiLiveControlsDto, PiLiveEventDto, PiLiveQueueDto, PiLiveSnapshotDto, PiLiveStateDto } from '@agent-lens/protocol'
import { piLiveApi, type PiLiveTransportDiagnostics } from '../client/pi-live'
import { VirtualRoundMount } from '../components/VirtualRoundMount'
import { ComposerPillSelect } from '../components/ComposerPillSelect'
import { PiMarkdownComposer, type PiMarkdownComposerHandle } from '../components/PiMarkdownComposer'
import { PiStartupDisclosure, piStartupSummary } from '../components/PiStartupDisclosure'
import { Button, IconButton, Input, Textarea } from '../components/ui'
import { UiIcon } from '../components/UiIcon'
import { projectPiLiveHistory, type PiLiveHistoryItem } from './pi-live-history'
import { PiLiveHistoryTaskRound, PiLiveRunningTaskRound } from './PiLiveTaskRound'
import { piLiveTaskRoundEstimate, projectPiLiveRunningRound, projectPiLiveTaskDetail, projectPiLiveTaskRounds } from './pi-live-task-projection'
import { TaskHeader } from './TaskHeader'
import { TaskSurface } from './TaskSurface'

type QueueMode = 'steer' | 'followUp'
interface RestoredDraft { id: string; mode: QueueMode; text: string }
interface LiveTool {
  id: string
  name: string
  status: 'running' | 'success' | 'error'
  summary: string
  output: string
}
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
const PI_LIVE_STARTUP_BACKGROUND = {
  model: {
    id: 'background:startup',
    label: '后台活动',
    state: 'settled' as const,
    toolCount: 0,
    errorCount: 0,
    durationMs: 0,
    highLatency: false,
  },
  items: [] as PiLiveHistoryItem[],
  continuation: false,
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

function formatClock(value: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function modelLabel(state: PiLiveStateDto | null): string {
  if (!state?.model) return 'Pi'
  const model = record(state.model)
  const provider = stringValue(model.provider)
  const id = stringValue(model.id || model.modelId || model.name)
  return [provider, id].filter(Boolean).join(' / ') || 'Pi'
}

function modelCompactLabel(state: PiLiveStateDto | null): string {
  if (!state?.model) return '模型'
  const model = record(state.model)
  return stringValue(model.name || model.id || model.modelId) || '模型'
}

function thinkingLevelLabel(level: string): string {
  const normalized = level.trim().toLowerCase()
  if (normalized === 'minimal' || normalized === 'none' || normalized === 'off') return '极简'
  if (normalized === 'low') return '低'
  if (normalized === 'medium') return '中'
  if (normalized === 'high') return '高'
  if (normalized === 'xhigh' || normalized === 'max' || normalized === 'maximum') return '极高'
  return level
}

function modelSelection(state: PiLiveStateDto | null): string {
  if (!state?.model) return ''
  const model = record(state.model)
  const provider = stringValue(model.provider)
  const id = stringValue(model.id || model.modelId)
  return provider && id ? JSON.stringify([provider, id]) : ''
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

function extensionRequest(event: Record<string, unknown>): ExtensionRequest | null {
  if (event.type !== 'extension_ui_request') return null
  const id = stringValue(event.id)
  const method = stringValue(event.method)
  if (!id || !['select', 'confirm', 'input', 'editor'].includes(method)) return null
  return {
    id,
    method,
    title: stringValue(event.title) || 'Pi 需要你的确认',
    message: stringValue(event.message),
    options: Array.isArray(event.options) ? event.options.filter((item): item is string => typeof item === 'string') : [],
    placeholder: stringValue(event.placeholder),
    prefill: stringValue(event.prefill),
  }
}

function PiLiveStart({ known }: { known: PiLiveStateDto[] }) {
  const navigate = useNavigate()
  const [cwd, setCwd] = useState(() => {
    try { return localStorage.getItem('agent-lens:pi-live-last-cwd') ?? '' } catch { return '' }
  })
  const [model, setModel] = useState('')
  const [provider, setProvider] = useState('')
  const [availability, setAvailability] = useState<string>('正在检测 Pi…')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    void piLiveApi.availability().then(value => {
      if (cancelled) return
      setAvailability(value.available ? `Pi 已就绪 · ${value.executable ?? 'PATH'}` : `Pi 不可用 · ${value.reason ?? '未找到可执行文件'}`)
    }, reason => {
      if (!cancelled) setAvailability(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { cancelled = true }
  }, [])

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
      <div className="pi-live-start-kicker">任务复盘 · Pi 实时任务</div>
      <h1>开始一个 Pi 任务</h1>
      <p>Pi 由 AgentLens 后台服务持有。关闭页面、刷新浏览器或切去任务复盘，不会自动结束正在执行的任务。</p>
      <label>工作目录<Input value={cwd} onChange={event => setCwd(event.target.value)} placeholder="例如 F:\\workspace\\agent-lens 或 /workspace/agent-lens" autoFocus/></label>
      <details>
        <summary>模型设置（可选）</summary>
        <div className="pi-live-start-grid">
          <label>Provider<Input value={provider} onChange={event => setProvider(event.target.value)} placeholder="留空使用 Pi 默认"/></label>
          <label>Model<Input value={model} onChange={event => setModel(event.target.value)} placeholder="留空使用 Pi 默认"/></label>
        </div>
      </details>
      <div className="pi-live-start-status">{availability}</div>
      {error && <div className="pi-live-error" role="alert">{error}</div>}
      <div className="pi-live-start-actions">
        <Button onClick={() => navigate('/review')}>返回任务复盘</Button>
        <Button variant="primary" loading={starting} disabled={!cwd.trim()} onClick={() => void start()}>启动 Pi</Button>
      </div>
    </section>
    {known.length > 0 && <section className="pi-live-known-card">
      <div><b>仍在后台的 Pi 任务</b><span>来自本浏览器最近启动的运行时</span></div>
      {known.map(item => <button key={item.runtimeSessionId} onClick={() => navigate(`/review/live/${encodeURIComponent(item.runtimeSessionId)}`)}>
        <span>{item.sessionName || 'Pi 实时任务'}</span>
        <small>{modelLabel(item)} · {item.status === 'initializing' ? '正在初始化' : item.status === 'failed' ? '启动失败' : item.isStreaming ? '正在工作' : '等待输入'}</small>
      </button>)}
    </section>}
  </main>
}

function ExtensionPrompt({ request, onAnswer }: { request: ExtensionRequest; onAnswer(value: JsonValue): void }) {
  const [value, setValue] = useState(request.prefill)
  useEffect(() => setValue(request.prefill), [request.id, request.prefill])

  if (request.method === 'confirm') {
    return <div className="pi-live-blocking" role="dialog" aria-label={request.title}>
      <div><b>{request.title}</b>{request.message && <span>{request.message}</span>}</div>
      <div className="pi-live-blocking-actions"><Button size="small" onClick={() => onAnswer({ confirmed: false })}>拒绝</Button><Button size="small" variant="primary" onClick={() => onAnswer({ confirmed: true })}>允许</Button></div>
    </div>
  }
  if (request.method === 'select') {
    return <div className="pi-live-blocking" role="dialog" aria-label={request.title}>
      <div><b>{request.title}</b>{request.message && <span>{request.message}</span>}</div>
      <div className="pi-live-blocking-options">{request.options.map(option => <Button size="small" key={option} onClick={() => onAnswer({ value: option })}>{option}</Button>)}<Button size="small" onClick={() => onAnswer({ cancelled: true })}>取消</Button></div>
    </div>
  }
  return <div className="pi-live-blocking pi-live-blocking-input" role="dialog" aria-label={request.title}>
    <div><b>{request.title}</b>{request.message && <span>{request.message}</span>}</div>
    {request.method === 'editor'
      ? <Textarea className="pi-live-blocking-field" value={value} onChange={event => setValue(event.target.value)} placeholder={request.placeholder}/>
      : <Input className="pi-live-blocking-field" value={value} onChange={event => setValue(event.target.value)} placeholder={request.placeholder}/>}
    <div className="pi-live-blocking-actions"><Button size="small" onClick={() => onAnswer({ cancelled: true })}>取消</Button><Button size="small" variant="primary" onClick={() => onAnswer({ value })}>提交</Button></div>
  </div>
}

export function PiLivePage({ embedded = false }: { embedded?: boolean }) {
  const navigate = useNavigate()
  const { runtimeSessionId } = useParams()
  const runtimeId = runtimeSessionId ? decodeURIComponent(runtimeSessionId) : ''
  const readerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<PiMarkdownComposerHandle>(null)
  const followingRef = useRef(true)
  const followFrameRef = useRef<number | null>(null)
  const leafIdRef = useRef<string | undefined>(undefined)
  const toolsRef = useRef(new Map<string, LiveTool>())
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
  const [settledCurrentOrdinal, setSettledCurrentOrdinal] = useState<number | null>(null)
  const [settledCurrentItems, setSettledCurrentItems] = useState<PiLiveHistoryItem[]>([])
  const [streamText, setStreamText] = useState('')
  const [thinkingText, setThinkingText] = useState('')
  const [tools, setTools] = useState<LiveTool[]>([])
  const [queue, setQueue] = useState<PiLiveQueueDto>({ steering: [], followUp: [] })
  const [restored, setRestored] = useState<RestoredDraft[]>([])
  const [extension, setExtension] = useState<ExtensionRequest | null>(null)
  const [extensionPending, setExtensionPending] = useState(false)
  const [controlBusy, setControlBusy] = useState(false)
  const [diagnostics, setDiagnostics] = useState<PiLiveTransportDiagnostics | null>(null)
  const [newRecords, setNewRecords] = useState(false)
  const [showAllEvents, setShowAllEvents] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void piLiveApi.knownRuntimes().then(value => { if (!cancelled) setKnown(value) }, () => undefined)
    return () => { cancelled = true }
  }, [runtimeId])

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
    setSettledCurrentOrdinal(null)
    setSettledCurrentItems([])
    setStreamText('')
    setThinkingText('')
    setTools([])
    toolsRef.current.clear()
    setQueue({ steering: [], followUp: [] })
    setRestored([])
    setExtension(null)
    setError('')
    setShowAllEvents(true)
    setStartupQueued('')
    setComposerExpanded(false)
    startupSendingRef.current = false
    activePromptRef.current = ''
    leafIdRef.current = undefined

    const acceptSnapshot = (value: PiLiveSnapshotDto) => {
      if (!active || value.state.runtimeSessionId !== runtimeId) return
      setSnapshot(current => mergeSnapshot(current, value))
      setState(value.state)
      leafIdRef.current = value.leafId ?? undefined
      window.dispatchEvent(new Event('agent-lens:pi-live-state-changed'))
      if (value.state.status === 'ready') void refreshControls()
    }

    const refreshControls = async () => {
      try {
        const value = await piLiveApi.controls(runtimeId)
        if (active) setControls(value)
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : String(reason))
      }
    }

    const refreshAfterSettled = async () => {
      try {
        const value = await piLiveApi.snapshot(runtimeId, leafIdRef.current)
        if (!active) return
        const prompt = activePromptRef.current.trim()
        const freshHistory = projectPiLiveHistory(value)
        const freshRounds = projectPiLiveTaskRounds(freshHistory)
        const matchedRound = prompt
          ? [...freshRounds].reverse().find(round => round.model.ordinal !== undefined && round.items.some(item => item.kind === 'message' && item.role === 'user' && item.text.trim() === prompt))
          : undefined
        const ordinal = matchedRound?.model.ordinal ?? null
        const settledItems = ordinal === null
          ? []
          : freshRounds.filter(round => round.model.ordinal === ordinal).flatMap(round => round.items)
        acceptSnapshot(value)
        if (ordinal !== null && settledItems.length > 0) {
          setSettledCurrentOrdinal(ordinal)
          setSettledCurrentItems(settledItems)
          setOptimisticPrompt(prompt)
        } else {
          setSettledCurrentOrdinal(null)
          setSettledCurrentItems([])
          setOptimisticPrompt('')
        }
        activePromptRef.current = ''
        setStreamText('')
        setThinkingText('')
        toolsRef.current.clear()
        setTools([])
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : String(reason))
      }
    }

    const dispose = piLiveApi.connect(runtimeId, {
      onConnection: value => { if (active) setConnected(value) },
      onSnapshot: acceptSnapshot,
      onError: reason => { if (active) setError(reason.message) },
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
            setStreamText('')
            setThinkingText('')
            toolsRef.current.clear()
            setTools([])
          } else if (type === 'agent_settled') {
            statePatch = { ...statePatch, isStreaming: false, pendingMessageCount: 0 }
            settled = true
          } else if (type === 'compaction_start') {
            statePatch = { ...statePatch, isCompacting: true }
          } else if (type === 'compaction_end') {
            statePatch = { ...statePatch, isCompacting: false }
          } else if (type === 'model_changed' || type === 'thinking_level_changed') {
            controlsChanged = true
          } else if (type === 'message_update') {
            const update = record(event.assistantMessageEvent)
            const delta = stringValue(update.delta)
            if (update.type === 'text_delta' && delta) setStreamText(value => value + delta)
            if (update.type === 'thinking_delta' && delta) setThinkingText(value => value + delta)
          } else if (type === 'tool_execution_start') {
            const id = stringValue(event.toolCallId)
            if (id) {
              toolsRef.current.set(id, {
                id,
                name: stringValue(event.toolName) || 'tool',
                status: 'running',
                summary: brief(event.args),
                output: '',
              })
              setTools([...toolsRef.current.values()])
            }
          } else if (type === 'tool_execution_update') {
            const id = stringValue(event.toolCallId)
            const current = toolsRef.current.get(id)
            if (current) {
              toolsRef.current.set(id, { ...current, output: toolOutput(event.partialResult) })
              setTools([...toolsRef.current.values()])
            }
          } else if (type === 'tool_execution_end') {
            const id = stringValue(event.toolCallId)
            const current = toolsRef.current.get(id)
            if (current) {
              toolsRef.current.set(id, {
                ...current,
                status: event.isError === true ? 'error' : 'success',
                output: toolOutput(event.result) || current.output,
              })
              setTools([...toolsRef.current.values()])
            }
          } else if (type === 'queue_update') {
            const steering = Array.isArray(event.steering) ? event.steering.filter((item): item is string => typeof item === 'string') : []
            const followUp = Array.isArray(event.followUp) ? event.followUp.filter((item): item is string => typeof item === 'string') : []
            setQueue({ steering, followUp })
            statePatch = { ...statePatch, pendingMessageCount: steering.length + followUp.length }
          } else if (type === 'runtime_resources') {
            const startupResources = parseStartupResources(event.resources)
            if (startupResources) statePatch = { ...statePatch, startupResources }
          } else if (type === 'runtime_output') {
            const message = stringValue(event.message).trim()
            if (message) {
              setState(current => current ? { ...current, startupOutput: [...(current.startupOutput ?? []), message].slice(-80) } : current)
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
            if (status === 'ready' || initializationStage === 'ready') {
              void refreshAfterSettled()
              void refreshControls()
            }
          } else {
            const request = extensionRequest(event)
            if (request) setExtension(request)
            if (type === 'extension_error') setError(stringValue(event.error) || 'Pi Extension 执行失败')
            if (type === 'runtime_exit') {
              setError(stringValue(event.errorMessage) || 'Pi Runtime 已退出')
              statePatch = { ...statePatch, isStreaming: false, isCompacting: false }
            }
          }
        }
        if (Object.keys(statePatch).length) setState(current => current ? { ...current, ...statePatch } : current)
        setDiagnostics(nextDiagnostics)
        if (!followingRef.current) setNewRecords(true)
        if (settled) void refreshAfterSettled()
        if (controlsChanged) {
          void piLiveApi.state(runtimeId).then(value => { if (active) setState(value) }, () => undefined)
          void refreshControls()
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
  const visibleHistoryRounds = useMemo(() => settledCurrentOrdinal === null
    ? historyRounds
    : historyRounds.filter(round => round.model.ordinal !== settledCurrentOrdinal), [historyRounds, settledCurrentOrdinal])
  const optimisticStreaming = ((Boolean(optimisticPrompt) && settledCurrentOrdinal === null) || (state?.isStreaming ?? false))
  const runningRound = useMemo(() => {
    if (settledCurrentOrdinal !== null) {
      const settledProjection = historyRounds.find(round => round.model.ordinal === settledCurrentOrdinal && !round.continuation)
      if (settledProjection) return { ...settledProjection.model, id: 'pi-live-current-round' }
    }
    if (!optimisticPrompt && !state?.isStreaming && !thinkingText && tools.length === 0 && !streamText) return undefined
    return projectPiLiveRunningRound({ tools, isStreaming: optimisticStreaming })
  }, [historyRounds, optimisticPrompt, optimisticStreaming, settledCurrentOrdinal, state?.isStreaming, streamText, thinkingText, tools])
  const taskDetailModel = useMemo(() => projectPiLiveTaskDetail({
    state,
    connected,
    historyRounds,
    runningRound,
  }), [connected, historyRounds, runningRound, state])

  const beginOptimisticPrompt = useCallback((text: string) => {
    setSettledCurrentOrdinal(null)
    setSettledCurrentItems([])
    activePromptRef.current = text
    setOptimisticPrompt(text)
    setState(current => current ? { ...current, isStreaming: true } : current)
  }, [])

  const rollbackOptimisticPrompt = useCallback((text: string) => {
    if (activePromptRef.current !== text) return
    activePromptRef.current = ''
    setOptimisticPrompt('')
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
  }, [visibleHistoryRounds, streamText, thinkingText, tools, optimisticPrompt, settledCurrentItems, queue.steering.length, queue.followUp.length, restored, extension?.id])

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

  const runtimeReady = state?.status === 'ready'
  const runtimeInitializing = !state || state.status === 'initializing'
  const runtimeTerminating = state?.status === 'terminating'
  const canStageStartup = runtimeInitializing && !startupQueued

  const send = async (forcedMode?: QueueMode) => {
    const text = input.trim()
    if (!text || busy || extension) return
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
    setBusy(true)
    setError('')
    setInput('')
    if (!wasStreaming) beginOptimisticPrompt(text)
    inputRef.current?.focus({ preventScroll: true })
    try {
      await piLiveApi.prompt(runtimeId, text, wasStreaming ? selectedMode : undefined)
    } catch (reason) {
      setInput(current => current || text)
      if (!wasStreaming) rollbackOptimisticPrompt(text)
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
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

  const stop = async () => {
    if (!state?.isStreaming || busy) return
    setBusy(true)
    setError('')
    try {
      const pending = await piLiveApi.abort(runtimeId, true)
      const drafts: RestoredDraft[] = [
        ...pending.steering.map((text, index) => ({ id: `steer-${Date.now()}-${index}`, mode: 'steer' as const, text })),
        ...pending.followUp.map((text, index) => ({ id: `follow-${Date.now()}-${index}`, mode: 'followUp' as const, text })),
      ]
      setRestored(drafts)
      setQueue({ steering: [], followUp: [] })
      setState(current => current ? { ...current, isStreaming: false, pendingMessageCount: 0 } : current)
      inputRef.current?.focus({ preventScroll: true })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
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
    ...queue.steering.map((text, index) => ({ id: `active-steer-${index}`, mode: 'steer' as QueueMode, text, active: true })),
    ...queue.followUp.map((text, index) => ({ id: `active-follow-${index}`, mode: 'followUp' as QueueMode, text, active: true })),
    ...restored.map(item => ({ ...item, active: false })),
  ]
  const selectedModel = modelSelection(state)
  const canSend = Boolean(input.trim()) && !busy && !extension && !runtimeTerminating && (runtimeReady ? !startupQueued : canStageStartup)
  const composerStatus = startupQueued
    ? { label: '待发送', color: 'var(--al-accent)', title: '等待 Pi 就绪后自动发送' }
    : runtimeInitializing
      ? { label: '初始化', color: 'var(--al-accent)', title: state?.initializationMessage || 'Pi Runtime 正在初始化' }
      : state?.status === 'failed'
        ? { label: '失败', color: 'var(--al-danger)', title: state.error || error || 'Pi Runtime 初始化失败' }
        : connected
          ? { label: '已连接', color: 'var(--al-success)', title: 'Pi 实时通道已连接' }
          : { label: '重连', color: 'var(--al-warning)', title: 'Pi 实时通道正在重新连接' }
  const diagnosticsTitle = diagnostics
    ? `事件 ${diagnostics.ingressEvents} · 合并 ${diagnostics.coalescedEvents} · 峰值队列 ${diagnostics.maxQueueDepth} · 最近提交 ${diagnostics.lastFlushLatencyMs.toFixed(1)}ms${diagnostics.hidden ? ' · 后台降频' : ''}`
    : ''
  const inputPlaceholder = runtimeInitializing
    ? 'Pi 正在初始化，可以先输入任务…'
    : state?.isStreaming ? '继续指导 Pi…' : '输入任务…'
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
      <div className="pi-live-sessions-head"><div><b>Pi 实时任务</b><small>关闭视图不结束任务</small></div><Button size="small" onClick={() => navigate('/review/live')}>新建</Button></div>
      <div className="pi-live-session-scroll">
        {known.map(item => <button key={item.runtimeSessionId} className={`pi-live-session ${item.runtimeSessionId === runtimeId ? 'active' : ''}`} onClick={() => navigate(`/review/live/${encodeURIComponent(item.runtimeSessionId)}`)}>
          <div className="pi-live-session-top"><span className={item.isStreaming || item.status === 'initializing' ? 'pi-live-pulse' : 'pi-live-idle-dot'}/><span>Pi</span><span>{item.status === 'initializing' ? '启动中' : item.status === 'failed' ? '失败' : item.isStreaming ? '实时' : '空闲'}</span></div>
          <div className="pi-live-session-title">{item.sessionName || 'Pi 实时任务'}</div>
          <div className="pi-live-session-foot"><span>{modelLabel(item)}</span><span>PID {item.processId ?? '—'}</span></div>
        </button>)}
        {!known.length && <div className="pi-live-side-empty">当前浏览器没有记录到其他后台 Pi 任务。</div>}
        <button className="pi-live-review-link" onClick={() => navigate('/review?source=pi')}>查看 Pi 历史复盘 <UiIcon name="arrow-right" size={14}/></button>
      </div>
    </aside>}

    <TaskSurface mode="live" className="pi-live-workspace">
      <TaskHeader
        marker={<span className={state?.isStreaming ? 'pi-live-pulse' : 'pi-live-idle-dot'}/>}
        agent={taskDetailModel.agentLabel}
        context={taskDetailModel.contextLabel}
        status={<span className={!connected ? 'pi-live-disconnected' : undefined}>{taskDetailModel.statusLabel}</span>}
        title={taskDetailModel.title}
        metrics={taskDetailModel.metrics}
        actions={<>
          <Button size="small" className="review-audit-toggle" aria-pressed={showAllEvents} onClick={() => setShowAllEvents(value => !value)}>{showAllEvents ? '视图：全部事件' : '视图：核心事件'}</Button>
          <Button size="small" className="pi-live-stop" disabled={!state?.isStreaming || busy} onClick={() => void stop()}>停止当前任务</Button>
          <IconButton size="small" variant="danger" className="pi-live-menu" title="结束 Pi Runtime" aria-label="结束 Pi Runtime" disabled={busy} onClick={() => void terminate()}><UiIcon name="close" size={14}/></IconButton>
        </>}
      />

      <div ref={readerRef} className="pi-live-reader" onScroll={onReaderScroll}>
        <div className="pi-live-document">
          {startupState && !hasBackgroundRound && <PiLiveHistoryTaskRound
            projection={PI_LIVE_STARTUP_BACKGROUND}
            showAllEvents={showAllEvents}
            beforeContent={startupContent}
            summaryMeta={startupSummaryMeta}
          />}
          {visibleHistoryRounds.map((projection, index) => {
            const carriesStartup = Boolean(startupState && projection.model.id === 'background:0')
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

          {runningRound && <PiLiveRunningTaskRound
            model={runningRound}
            {...(optimisticPrompt ? { promptText: optimisticPrompt } : {})}
            {...(settledCurrentItems.length ? { settledItems: settledCurrentItems } : {})}
            showAllEvents={showAllEvents}
            thinkingText={thinkingText}
            tools={tools}
            streamText={streamText}
            isStreaming={optimisticStreaming}
            pendingMessageCount={state?.pendingMessageCount ?? 0}
          />}
          {!history.length && !optimisticPrompt && !streamText && !thinkingText && !tools.length && runtimeReady && <div className="pi-live-empty">这个 Pi Runtime 还没有消息。可以直接在下方输入开始任务。</div>}
          {error && <div className="pi-live-error pi-live-reader-error" role="alert">{error}</div>}
        </div>
      </div>

      <div className="pi-live-compose-wrap">
        <div className="pi-live-float-stack">
          {newRecords && <Button size="small" className="pi-live-new-records" onClick={jumpLatest}>有新记录 <UiIcon name="arrow-down" size={14}/></Button>}
          {startupQueued && <div className="pi-live-startup-queue" role="status">
            <span>等待 Pi 就绪</span><b>{startupQueued}</b><div><Button size="small" className="pi-live-queue-action" onClick={editStartupQueued}>编辑</Button><Button size="small" className="pi-live-queue-action" onClick={removeStartupQueued}>撤回</Button></div>
          </div>}
          {queueItems.length > 0 && <div className="pi-live-queue">{queueItems.map(item => <div key={item.id} className={`pi-live-queue-item ${item.active ? 'active' : 'restored'}`}>
            <span>{item.mode === 'steer' ? '待介入' : '完成后继续'}</span><b>{item.text}</b>
            {item.active ? <small>已在 Pi 队列</small> : <div><Button size="small" className="pi-live-queue-action" onClick={() => editRestored(item)}>编辑</Button><Button size="small" className="pi-live-queue-action" onClick={() => removeRestored(item.id)}>撤回</Button></div>}
          </div>)}</div>}
          {extension && <ExtensionPrompt request={extension} onAnswer={value => { if (!extensionPending) void answerExtension(value) }}/>} 
        </div>
        <div className={`pi-live-composer ${composerExpanded ? 'is-expanded' : ''}`}>
          <div className="pi-live-editor">
            <div className="pi-live-editor-toolbar" aria-label="输入区工具">
              <IconButton
                size="small"
                className="pi-live-editor-action"
                title={composerExpanded ? '缩小输入区' : '放大输入区'}
                aria-label={composerExpanded ? '缩小输入区' : '放大输入区'}
                onClick={() => setComposerExpanded(value => !value)}
              ><UiIcon name={composerExpanded ? 'collapse' : 'expand'} size={16}/></IconButton>
            </div>
            <PiMarkdownComposer
              ref={inputRef}
              value={input}
              onChange={setInput}
              canSubmit={canSend}
              onSubmit={submitMode => void send(submitMode === 'followUp' ? 'followUp' : undefined)}
              onEscape={state?.isStreaming ? () => void stop() : undefined}
              placeholder={inputPlaceholder}
              title="输入 Markdown 会自动格式化 · Enter 发送 · Alt+Enter 完成后继续 · Shift+Enter 换行 · 生成中 Esc 中断"
              ariaLabel="Pi Markdown 富文本输入"
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
                ariaLabel="Pi 模型"
                title={state?.model ? `Pi 模型 · ${modelLabel(state)}` : 'Pi 模型'}
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
                ariaLabel="Pi 推理强度"
                title={`Pi 推理强度 · ${state?.thinkingLevel || '未设置'}`}
                value={state?.thinkingLevel ?? ''}
                placeholder={state?.thinkingLevel ? thinkingLevelLabel(state.thinkingLevel) : '推理'}
                className="pi-live-thinking-picker"
                menuWidth={168}
                disabled={!runtimeReady || controlBusy || controls.thinkingLevels.length === 0}
                options={controls.thinkingLevels.map(level => ({ value: level, label: thinkingLevelLabel(level) }))}
                onChange={level => void changeThinkingLevel(level)}
              />
            </div>
            <div className="pi-live-compose-mode" aria-label="发送方式">
              <Button size="small" className={`pi-live-mode-action ${mode === 'steer' ? 'active' : ''}`} title="立即介入当前生成（Enter）" aria-pressed={mode === 'steer'} onClick={() => { setMode('steer'); requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true })) }}>介入</Button>
              <Button size="small" className={`pi-live-mode-action ${mode === 'followUp' ? 'active' : ''}`} title="当前轮次完成后继续（Alt+Enter）" aria-pressed={mode === 'followUp'} onClick={() => { setMode('followUp'); requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true })) }}>继续</Button>
            </div>
            <IconButton variant="primary" className="pi-live-send" disabled={!canSend} onClick={() => void send()} aria-label={runtimeReady ? '发送' : 'Pi 就绪后发送'}><UiIcon name="send" size={20}/></IconButton>
          </div>
        </div>
      </div>
    </TaskSurface>
  </main>
}
