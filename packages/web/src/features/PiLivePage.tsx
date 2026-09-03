import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useNavigate, useParams } from 'react-router-dom'
import type { JsonValue, PiLiveControlsDto, PiLiveEventDto, PiLiveQueueDto, PiLiveSnapshotDto, PiLiveStateDto } from '@agent-lens/protocol'
import { piLiveApi, type PiLiveTransportDiagnostics } from '../client/pi-live'
import { VirtualRoundMount } from '../components/VirtualRoundMount'
import { projectPiLiveHistory, type PiLiveHistoryItem } from './pi-live-history'
import { PiLiveHistoryTaskRound, PiLiveRunningTaskRound } from './PiLiveTaskRound'
import { piLiveTaskRoundEstimate, projectPiLiveRunningRound, projectPiLiveTaskDetail, projectPiLiveTaskRounds } from './pi-live-task-projection'
import { TaskHeader } from './TaskHeader'
import { TaskSurface } from './TaskSurface'

type QueueMode = 'steer' | 'followUp'
type ComposerView = 'edit' | 'preview'
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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
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

function ComposerExpandIcon({ expanded }: { expanded: boolean }) {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    {expanded
      ? <><path d="M6.2 2.5v3.7H2.5"/><path d="m2.8 6 3.4-3.4"/><path d="M9.8 13.5V9.8h3.7"/><path d="m13.2 10-3.4 3.4"/></>
      : <><path d="M6.2 2.5H2.5v3.7"/><path d="m2.8 2.8 3.4 3.4"/><path d="M9.8 13.5h3.7V9.8"/><path d="m13.2 13.2-3.4-3.4"/></>}
  </svg>
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
      <label>工作目录<input value={cwd} onChange={event => setCwd(event.target.value)} placeholder="例如 F:\\workspace\\agent-lens 或 /workspace/agent-lens" autoFocus/></label>
      <details>
        <summary>模型设置（可选）</summary>
        <div className="pi-live-start-grid">
          <label>Provider<input value={provider} onChange={event => setProvider(event.target.value)} placeholder="留空使用 Pi 默认"/></label>
          <label>Model<input value={model} onChange={event => setModel(event.target.value)} placeholder="留空使用 Pi 默认"/></label>
        </div>
      </details>
      <div className="pi-live-start-status">{availability}</div>
      {error && <div className="pi-live-error" role="alert">{error}</div>}
      <div className="pi-live-start-actions">
        <button className="btn" onClick={() => navigate('/review')}>返回任务复盘</button>
        <button className="btn primary" disabled={!cwd.trim() || starting} onClick={() => void start()}>{starting ? '正在启动…' : '启动 Pi'}</button>
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
      <div className="pi-live-blocking-actions"><button onClick={() => onAnswer({ confirmed: false })}>拒绝</button><button className="allow" onClick={() => onAnswer({ confirmed: true })}>允许</button></div>
    </div>
  }
  if (request.method === 'select') {
    return <div className="pi-live-blocking" role="dialog" aria-label={request.title}>
      <div><b>{request.title}</b>{request.message && <span>{request.message}</span>}</div>
      <div className="pi-live-blocking-options">{request.options.map(option => <button key={option} onClick={() => onAnswer({ value: option })}>{option}</button>)}<button onClick={() => onAnswer({ cancelled: true })}>取消</button></div>
    </div>
  }
  return <div className="pi-live-blocking pi-live-blocking-input" role="dialog" aria-label={request.title}>
    <div><b>{request.title}</b>{request.message && <span>{request.message}</span>}</div>
    {request.method === 'editor'
      ? <textarea value={value} onChange={event => setValue(event.target.value)} placeholder={request.placeholder}/>
      : <input value={value} onChange={event => setValue(event.target.value)} placeholder={request.placeholder}/>}
    <div className="pi-live-blocking-actions"><button onClick={() => onAnswer({ cancelled: true })}>取消</button><button className="allow" onClick={() => onAnswer({ value })}>提交</button></div>
  </div>
}

export function PiLivePage({ embedded = false }: { embedded?: boolean }) {
  const navigate = useNavigate()
  const { runtimeSessionId } = useParams()
  const runtimeId = runtimeSessionId ? decodeURIComponent(runtimeSessionId) : ''
  const readerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const followingRef = useRef(true)
  const leafIdRef = useRef<string | undefined>(undefined)
  const toolsRef = useRef(new Map<string, LiveTool>())
  const startupSendingRef = useRef(false)
  const [known, setKnown] = useState<PiLiveStateDto[]>([])
  const [snapshot, setSnapshot] = useState<PiLiveSnapshotDto | null>(null)
  const [state, setState] = useState<PiLiveStateDto | null>(null)
  const [controls, setControls] = useState<PiLiveControlsDto>({ models: [], thinkingLevels: [] })
  const [connected, setConnected] = useState(false)
  const [mode, setMode] = useState<QueueMode>('steer')
  const [input, setInput] = useState('')
  const [composerView, setComposerView] = useState<ComposerView>('edit')
  const [composerExpanded, setComposerExpanded] = useState(false)
  const [startupQueued, setStartupQueued] = useState('')
  const [composing, setComposing] = useState(false)
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
    setSnapshot(null)
    setState(null)
    setControls({ models: [], thinkingLevels: [] })
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
    setComposerView('edit')
    setComposerExpanded(false)
    startupSendingRef.current = false
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
        acceptSnapshot(value)
        setStreamText('')
        setThinkingText('')
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
          } else if (type === 'runtime_initialization' || type === 'runtime_status') {
            const status = stringValue(event.status)
            const initializationStage = stringValue(event.stage)
            const initializationMessage = stringValue(event.message)
            const runtimeError = stringValue(event.error)
            statePatch = {
              ...statePatch,
              ...(status ? { status: status as PiLiveStateDto['status'] } : {}),
              ...(initializationStage ? { initializationStage: initializationStage as PiLiveStateDto['initializationStage'] } : {}),
              ...(initializationMessage ? { initializationMessage } : {}),
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
    }
  }, [runtimeId])

  const history = useMemo(() => projectPiLiveHistory(snapshot), [snapshot])
  const historyRounds = useMemo(() => projectPiLiveTaskRounds(history), [history])
  const runningRound = useMemo(() => {
    if (!thinkingText && tools.length === 0 && !streamText) return undefined
    return projectPiLiveRunningRound({ tools, isStreaming: state?.isStreaming ?? false })
  }, [state?.isStreaming, streamText, thinkingText, tools])
  const taskDetailModel = useMemo(() => projectPiLiveTaskDetail({
    state,
    connected,
    historyRounds,
    runningRound,
  }), [connected, historyRounds, runningRound, state])

  useEffect(() => {
    if (!followingRef.current) return
    const frame = requestAnimationFrame(() => {
      const reader = readerRef.current
      if (reader) reader.scrollTop = reader.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [history.length, streamText, thinkingText, tools, queue.steering.length, queue.followUp.length, restored.length, extension?.id])

  // 初始化阶段先接住第一条任务；Worker ready 后只发送一次，失败则还原为可编辑草稿。
  useEffect(() => {
    if (!runtimeId || state?.status !== 'ready' || !startupQueued || startupSendingRef.current) return
    const text = startupQueued
    startupSendingRef.current = true
    setError('')
    void piLiveApi.prompt(runtimeId, text).then(() => {
      setStartupQueued(current => current === text ? '' : current)
      inputRef.current?.focus({ preventScroll: true })
    }, reason => {
      setStartupQueued(current => current === text ? '' : current)
      setInput(current => current || text)
      setComposerView('edit')
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      startupSendingRef.current = false
    })
  }, [runtimeId, startupQueued, state?.status])

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
      setComposerView('edit')
      inputRef.current?.focus({ preventScroll: true })
      return
    }
    if (startupQueued) return
    setBusy(true)
    setError('')
    try {
      const selectedMode = forcedMode ?? mode
      await piLiveApi.prompt(runtimeId, text, state?.isStreaming ? selectedMode : undefined)
      setInput('')
      setComposerView('edit')
      inputRef.current?.focus({ preventScroll: true })
    } catch (reason) {
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
    setComposerView('edit')
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
    setComposerView('edit')
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

  return <main className={`pi-live-page ${embedded ? 'pi-live-page-embedded' : ''}`}>
    {!embedded && <aside className="pi-live-sessions">
      <div className="pi-live-sessions-head"><div><b>Pi 实时任务</b><small>关闭视图不结束任务</small></div><button className="btn small" onClick={() => navigate('/review/live')}>新建</button></div>
      <div className="pi-live-session-scroll">
        {known.map(item => <button key={item.runtimeSessionId} className={`pi-live-session ${item.runtimeSessionId === runtimeId ? 'active' : ''}`} onClick={() => navigate(`/review/live/${encodeURIComponent(item.runtimeSessionId)}`)}>
          <div className="pi-live-session-top"><span className={item.isStreaming || item.status === 'initializing' ? 'pi-live-pulse' : 'pi-live-idle-dot'}/><span>Pi</span><span>{item.status === 'initializing' ? '启动中' : item.status === 'failed' ? '失败' : item.isStreaming ? '实时' : '空闲'}</span></div>
          <div className="pi-live-session-title">{item.sessionName || 'Pi 实时任务'}</div>
          <div className="pi-live-session-foot"><span>{modelLabel(item)}</span><span>PID {item.processId ?? '—'}</span></div>
        </button>)}
        {!known.length && <div className="pi-live-side-empty">当前浏览器没有记录到其他后台 Pi 任务。</div>}
        <button className="pi-live-review-link" onClick={() => navigate('/review?source=pi')}>查看 Pi 历史复盘 →</button>
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
          <button className="review-audit-toggle" aria-pressed={showAllEvents} onClick={() => setShowAllEvents(value => !value)}>{showAllEvents ? '视图：全部事件' : '视图：核心事件'}</button>
          <button className="pi-live-stop" disabled={!state?.isStreaming || busy} onClick={() => void stop()}>停止当前任务</button>
          <button className="pi-live-menu" title="结束 Pi Runtime" aria-label="结束 Pi Runtime" disabled={busy} onClick={() => void terminate()}>×</button>
        </>}
      />

      <div ref={readerRef} className="pi-live-reader" onScroll={onReaderScroll}>
        <div className="pi-live-document">
          {historyRounds.map((projection, index) => <VirtualRoundMount
            key={projection.model.id}
            rootSelector=".pi-live-reader"
            flowRoot
            eager={index >= historyRounds.length - PI_LIVE_EAGER_CHUNKS}
            estimate={piLiveTaskRoundEstimate(projection)}
          >
            <PiLiveHistoryTaskRound projection={projection} showAllEvents={showAllEvents}/>
          </VirtualRoundMount>)}

          {runningRound && <PiLiveRunningTaskRound
            model={runningRound}
            thinkingText={thinkingText}
            tools={tools}
            streamText={streamText}
            isStreaming={state?.isStreaming ?? false}
            pendingMessageCount={state?.pendingMessageCount ?? 0}
          />}
          {!history.length && !streamText && !thinkingText && !tools.length && state?.status === 'initializing' && <div className="pi-live-initializing" role="status"><span className="pi-live-stage-dot"/><b>{state.initializationMessage || '正在初始化 Pi Runtime'}</b><small>可以直接在下方输入任务；Pi 就绪后会自动发送已经排队的首条任务。</small><button onClick={() => void terminate()} disabled={busy}>取消启动</button></div>}
          {!history.length && !streamText && !thinkingText && !tools.length && state?.status === 'failed' && <div className="pi-live-initializing pi-live-initializing-failed" role="alert"><b>Pi Runtime 初始化失败</b><small>{state.error || error || 'Worker 未能完成初始化。'} 输入草稿会继续保留。</small><div><button onClick={() => void retry()} disabled={busy}>重试</button><button onClick={() => void terminate()} disabled={busy}>结束 Runtime</button></div></div>}
          {!history.length && !streamText && !thinkingText && !tools.length && runtimeReady && <div className="pi-live-empty">这个 Pi Runtime 还没有消息。可以直接在下方输入开始任务。</div>}
          {error && <div className="pi-live-error pi-live-reader-error" role="alert">{error}</div>}
        </div>
      </div>

      <div className="pi-live-compose-wrap">
        <div className="pi-live-float-stack">
          {newRecords && <button className="pi-live-new-records" onClick={jumpLatest}>有新记录 ↓</button>}
          {startupQueued && <div className="pi-live-startup-queue" role="status">
            <span>等待 Pi 就绪</span><b>{startupQueued}</b><div><button onClick={editStartupQueued}>编辑</button><button onClick={removeStartupQueued}>撤回</button></div>
          </div>}
          {queueItems.length > 0 && <div className="pi-live-queue">{queueItems.map(item => <div key={item.id} className={`pi-live-queue-item ${item.active ? 'active' : 'restored'}`}>
            <span>{item.mode === 'steer' ? '待介入' : '完成后继续'}</span><b>{item.text}</b>
            {item.active ? <small>已在 Pi 队列</small> : <div><button onClick={() => editRestored(item)}>编辑</button><button onClick={() => removeRestored(item.id)}>撤回</button></div>}
          </div>)}</div>}
          {extension && <ExtensionPrompt request={extension} onAnswer={value => { if (!extensionPending) void answerExtension(value) }}/>}
        </div>
        <div className={`pi-live-composer ${composerExpanded ? 'is-expanded' : ''}`}>
          <div className="pi-live-editor">
            <div className="pi-live-editor-toolbar" aria-label="Markdown 输入工具">
              <button
                type="button"
                className={composerView === 'preview' ? 'active' : ''}
                title={composerView === 'preview' ? '继续编辑 Markdown' : '预览 Markdown'}
                aria-label={composerView === 'preview' ? '继续编辑 Markdown' : '预览 Markdown'}
                onClick={() => {
                  setComposerView(value => value === 'edit' ? 'preview' : 'edit')
                  if (composerView === 'preview') requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
                }}
              >{composerView === 'preview' ? '编辑' : '预览'}</button>
              <button
                type="button"
                title={composerExpanded ? '缩小输入区' : '放大输入区'}
                aria-label={composerExpanded ? '缩小输入区' : '放大输入区'}
                onClick={() => setComposerExpanded(value => !value)}
              ><ComposerExpandIcon expanded={composerExpanded}/></button>
            </div>
            {composerView === 'preview'
              ? <div className="pi-live-markdown-preview markdown" role="region" aria-label="Markdown 预览">
                  {input.trim() ? <ReactMarkdown>{input}</ReactMarkdown> : <span className="pi-live-preview-empty">暂无可预览内容</span>}
                </div>
              : <textarea
                  ref={inputRef}
                  className="pi-live-input"
                  value={input}
                  onChange={event => setInput(event.target.value)}
                  onCompositionStart={() => setComposing(true)}
                  onCompositionEnd={() => setComposing(false)}
                  onKeyDown={event => {
                    if (composing || event.nativeEvent.isComposing || event.keyCode === 229) return
                    if (event.key === 'Escape' && state?.isStreaming) {
                      event.preventDefault()
                      void stop()
                      return
                    }
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      void send(event.altKey ? 'followUp' : undefined)
                    }
                  }}
                  placeholder={inputPlaceholder}
                  title="Enter 发送 · Alt+Enter 完成后继续 · Shift+Enter 换行 · 生成中 Esc 中断"
                  aria-label="Pi Markdown 输入"
                  disabled={runtimeTerminating}
                />}
          </div>
          <div className="pi-live-compose-bar">
            <span className="pi-live-compose-runtime" title={[composerStatus.title, diagnosticsTitle].filter(Boolean).join(' · ')}>
              <span className="pi-live-idle-dot" aria-hidden="true" style={{ background: composerStatus.color, borderColor: composerStatus.color }}/>
              {composerStatus.label}
            </span>
            <div className="pi-live-compose-settings">
              <select
                aria-label="Pi 模型"
                title={state?.model ? `Pi 模型 · ${modelLabel(state)}` : 'Pi 模型'}
                value={selectedModel}
                disabled={!runtimeReady || controlBusy || controls.models.length === 0}
                onChange={event => void changeModel(event.target.value)}
              >
                {!selectedModel && <option value="">模型</option>}
                {controls.models.map(item => <option key={`${item.provider}/${item.id}`} value={JSON.stringify([item.provider, item.id])}>{item.name || item.id}</option>)}
              </select>
              <select
                aria-label="Pi 推理强度"
                title={`Pi 推理强度 · ${state?.thinkingLevel || '未设置'}`}
                value={state?.thinkingLevel ?? ''}
                disabled={!runtimeReady || controlBusy || controls.thinkingLevels.length === 0}
                onChange={event => void changeThinkingLevel(event.target.value)}
              >
                {!state?.thinkingLevel && <option value="">推理</option>}
                {controls.thinkingLevels.map(level => <option key={level} value={level}>{thinkingLevelLabel(level)}</option>)}
              </select>
            </div>
            <div className="pi-live-compose-mode" aria-label="发送方式">
              <button title="立即介入当前生成（Enter）" className={mode === 'steer' ? 'active' : ''} aria-pressed={mode === 'steer'} onClick={() => { setMode('steer'); setComposerView('edit'); requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true })) }}>介入</button>
              <button title="当前轮次完成后继续（Alt+Enter）" className={mode === 'followUp' ? 'active' : ''} aria-pressed={mode === 'followUp'} onClick={() => { setMode('followUp'); setComposerView('edit'); requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true })) }}>继续</button>
            </div>
            <button className="pi-live-send" disabled={!canSend} onClick={() => void send()} aria-label={runtimeReady ? '发送' : 'Pi 就绪后发送'}>↑</button>
          </div>
        </div>
      </div>
    </TaskSurface>
  </main>
}
