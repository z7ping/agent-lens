import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useNavigate, useParams } from 'react-router-dom'
import type { JsonValue, PiLiveControlsDto, PiLiveEventDto, PiLiveQueueDto, PiLiveSnapshotDto, PiLiveStateDto } from '@agent-lens/protocol'
import { piLiveApi, type PiLiveTransportDiagnostics } from '../client/pi-live'
import { VirtualRoundMount } from '../components/VirtualRoundMount'
import { projectPiLiveHistory, type PiLiveHistoryItem } from './pi-live-history'
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

const PI_LIVE_HISTORY_CHUNK_SIZE = 8
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

function statusLabel(state: PiLiveStateDto | null, connected: boolean): string {
  if (!connected) return '实时通道断开'
  if (!state) return '正在连接'
  if (state.isCompacting) return '正在压缩上下文'
  if (state.isStreaming) return '正在工作'
  return '等待输入'
}

function PiLiveHistoryRow({ item }: { item: PiLiveHistoryItem }) {
  if (item.kind === 'message') {
    return <div className={`pi-live-chat-row ${item.role}`}>
      <div className={`pi-live-bubble ${item.role}`}>
        <div className="pi-live-message-meta"><b>{item.role === 'user' ? '你' : 'Pi'}</b>{item.at && <time>{formatClock(item.at)}</time>}</div>
        {item.role === 'assistant' ? <div className="markdown"><ReactMarkdown>{item.text}</ReactMarkdown></div> : <div>{item.text}</div>}
      </div>
    </div>
  }

  if (item.kind === 'thinking') {
    return <div className="pi-live-lane pi-live-history-lane">
      <details className="pi-live-thinking">
        <summary>可观察过程{item.at ? ` · ${formatClock(item.at)}` : ''}</summary>
        <div>{item.text}</div>
      </details>
    </div>
  }

  if (item.kind === 'tool') {
    return <div className="pi-live-lane pi-live-history-lane">
      <div className="pi-live-trace-stack">
        <div className={`pi-live-trace ${item.status}`}>
          <div className="pi-live-trace-head">
            <span className="pi-live-tool-icon">⌁</span>
            <b>{item.name}</b>
            <span>{item.summary}</span>
            <em>{item.status === 'error' ? '失败' : item.status === 'success' ? '完成' : '已记录'}</em>
          </div>
          {item.output && <details><summary>查看输出</summary><pre>{item.output}</pre></details>}
        </div>
      </div>
    </div>
  }

  return <div className="pi-live-history-lifecycle">
    <b>{item.label}</b>
    {item.detail && <span>{item.detail}</span>}
    {item.at && <time>{formatClock(item.at)}</time>}
  </div>
}

function historyEstimate(item: PiLiveHistoryItem): number {
  if (item.kind === 'message') {
    const lines = Math.max(1, Math.ceil(item.text.length / 72))
    return Math.min(360, 72 + lines * 24)
  }
  if (item.kind === 'thinking') return 64
  if (item.kind === 'tool') return item.output ? 92 : 58
  return 38
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
        <small>{modelLabel(item)} · {item.isStreaming ? '正在工作' : '等待输入'}</small>
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
  const [known, setKnown] = useState<PiLiveStateDto[]>([])
  const [snapshot, setSnapshot] = useState<PiLiveSnapshotDto | null>(null)
  const [state, setState] = useState<PiLiveStateDto | null>(null)
  const [controls, setControls] = useState<PiLiveControlsDto>({ models: [], thinkingLevels: [] })
  const [connected, setConnected] = useState(false)
  const [mode, setMode] = useState<QueueMode>('steer')
  const [input, setInput] = useState('')
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
    leafIdRef.current = undefined

    const acceptSnapshot = (value: PiLiveSnapshotDto) => {
      if (!active || value.state.runtimeSessionId !== runtimeId) return
      setSnapshot(current => mergeSnapshot(current, value))
      setState(value.state)
      leafIdRef.current = value.leafId ?? undefined
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

    void refreshControls()
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
  const historyChunks = useMemo(() => {
    const chunks: PiLiveHistoryItem[][] = []
    for (let index = 0; index < history.length; index += PI_LIVE_HISTORY_CHUNK_SIZE) {
      chunks.push(history.slice(index, index + PI_LIVE_HISTORY_CHUNK_SIZE))
    }
    return chunks
  }, [history])

  useEffect(() => {
    if (!followingRef.current) return
    const frame = requestAnimationFrame(() => {
      const reader = readerRef.current
      if (reader) reader.scrollTop = reader.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [history.length, streamText, thinkingText, tools, queue.steering.length, queue.followUp.length, restored.length, extension?.id])

  useEffect(() => {
    const textarea = inputRef.current
    if (!textarea) return
    const reader = readerRef.current
    const wasFollowing = followingRef.current
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.max(54, Math.min(textarea.scrollHeight, 160))}px`
    if (wasFollowing) requestAnimationFrame(() => { if (reader) reader.scrollTop = reader.scrollHeight })
  }, [input])

  if (!runtimeId) return <PiLiveStart known={known}/>

  const send = async (forcedMode?: QueueMode) => {
    const text = input.trim()
    if (!text || busy) return
    setBusy(true)
    setError('')
    try {
      const selectedMode = forcedMode ?? mode
      await piLiveApi.prompt(runtimeId, text, state?.isStreaming ? selectedMode : undefined)
      setInput('')
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
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
  }

  const removeRestored = (id: string) => {
    setRestored(items => items.filter(item => item.id !== id))
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

  const queueItems = [
    ...queue.steering.map((text, index) => ({ id: `active-steer-${index}`, mode: 'steer' as QueueMode, text, active: true })),
    ...queue.followUp.map((text, index) => ({ id: `active-follow-${index}`, mode: 'followUp' as QueueMode, text, active: true })),
    ...restored.map(item => ({ ...item, active: false })),
  ]
  const selectedModel = modelSelection(state)

  return <main className={`pi-live-page ${embedded ? 'pi-live-page-embedded' : ''}`}>
    {!embedded && <aside className="pi-live-sessions">
      <div className="pi-live-sessions-head"><div><b>Pi 实时任务</b><small>关闭视图不结束任务</small></div><button className="btn small" onClick={() => navigate('/review/live')}>新建</button></div>
      <div className="pi-live-session-scroll">
        {known.map(item => <button key={item.runtimeSessionId} className={`pi-live-session ${item.runtimeSessionId === runtimeId ? 'active' : ''}`} onClick={() => navigate(`/review/live/${encodeURIComponent(item.runtimeSessionId)}`)}>
          <div className="pi-live-session-top"><span className={item.isStreaming ? 'pi-live-pulse' : 'pi-live-idle-dot'}/><span>Pi</span><span>{item.isStreaming ? '实时' : '空闲'}</span></div>
          <div className="pi-live-session-title">{item.sessionName || 'Pi 实时任务'}</div>
          <div className="pi-live-session-foot"><span>{modelLabel(item)}</span><span>PID {item.processId ?? '—'}</span></div>
        </button>)}
        {!known.length && <div className="pi-live-side-empty">当前浏览器没有记录到其他后台 Pi 任务。</div>}
        <button className="pi-live-review-link" onClick={() => navigate('/review?source=pi')}>查看 Pi 历史复盘 →</button>
      </div>
    </aside>}

    <TaskSurface mode="live" className="pi-live-workspace">
      <header className="pi-live-taskbar">
        <div className="pi-live-task-main">
          <div className="pi-live-task-kicker"><span className={state?.isStreaming ? 'pi-live-pulse' : 'pi-live-idle-dot'}/><span>Pi · {statusLabel(state, connected)}</span>{!connected && <span className="pi-live-disconnected">任务仍由后台服务持有</span>}</div>
          <div className="pi-live-task-title">{state?.sessionName || 'Pi 实时任务'}</div>
        </div>
        <div className="pi-live-runtime">
          <button className="pi-live-stop" disabled={!state?.isStreaming || busy} onClick={() => void stop()}>停止当前任务</button>
          <button className="pi-live-menu" title="结束 Pi Runtime" aria-label="结束 Pi Runtime" disabled={busy} onClick={() => void terminate()}>×</button>
        </div>
      </header>

      <div ref={readerRef} className="pi-live-reader" onScroll={onReaderScroll}>
        <div className="pi-live-document">
          {historyChunks.map((chunk, index) => <VirtualRoundMount
            key={chunk[0]?.id ?? `history-chunk-${index}`}
            rootSelector=".pi-live-reader"
            flowRoot
            eager={index >= historyChunks.length - PI_LIVE_EAGER_CHUNKS}
            estimate={chunk.reduce((total, item) => total + historyEstimate(item), 0)}
          >
            <div className="pi-live-history-chunk">{chunk.map(item => <PiLiveHistoryRow key={item.id} item={item}/>)}</div>
          </VirtualRoundMount>)}

          {(thinkingText || tools.length > 0 || streamText) && <section className="pi-live-current-round">
            <div className="pi-live-round-head"><b>当前轮次</b><span>{state?.isStreaming ? '实时' : '已停止'}</span><span className="grow"/>{state?.pendingMessageCount ? <span>{state.pendingMessageCount} 条排队</span> : null}</div>
            <div className="pi-live-lane">
              <div className="pi-live-lane-head"><b>Pi</b><span>{state?.isStreaming ? '正在工作' : '当前输出'}</span></div>
              {thinkingText && <details className="pi-live-thinking"><summary>可观察过程片段</summary><div>{thinkingText}</div></details>}
              {tools.length > 0 && <div className="pi-live-trace-stack">{tools.map(tool => <div key={tool.id} className={`pi-live-trace ${tool.status}`}>
                <div className="pi-live-trace-head"><span className="pi-live-tool-icon">⌁</span><b>{tool.name}</b><span>{tool.summary}</span><em>{tool.status === 'running' ? '执行中' : tool.status === 'error' ? '失败' : '完成'}</em></div>
                {tool.output && <details><summary>查看输出</summary><pre>{tool.output}</pre></details>}
              </div>)}</div>}
              {streamText && <div className="pi-live-stream-response"><div className="pi-live-message-meta"><b>Pi</b><span>{state?.isStreaming ? '生成中' : '输出'}</span></div><div className="markdown"><ReactMarkdown>{streamText}</ReactMarkdown></div>{state?.isStreaming && <span className="pi-live-caret" aria-hidden="true"/>}</div>}
            </div>
          </section>}
          {!history.length && !streamText && !thinkingText && !tools.length && <div className="pi-live-empty">这个 Pi Runtime 还没有消息。可以直接在下方输入开始任务。</div>}
          {error && <div className="pi-live-error pi-live-reader-error" role="alert">{error}</div>}
        </div>
      </div>

      <div className="pi-live-compose-wrap">
        <div className="pi-live-float-stack">
          {newRecords && <button className="pi-live-new-records" onClick={jumpLatest}>有新记录 ↓</button>}
          {extension && <ExtensionPrompt request={extension} onAnswer={value => { if (!extensionPending) void answerExtension(value) }}/>} 
        </div>
        <div className="pi-live-composer">
          {queueItems.length > 0 && <div className="pi-live-queue">{queueItems.map(item => <div key={item.id} className={`pi-live-queue-item ${item.active ? 'active' : 'restored'}`}>
            <span>{item.mode === 'steer' ? '待介入' : '完成后继续'}</span><b>{item.text}</b>
            {item.active ? <small>已在 Pi 队列</small> : <div><button onClick={() => editRestored(item)}>编辑</button><button onClick={() => removeRestored(item.id)}>撤回</button></div>}
          </div>)}</div>}
          <textarea
            ref={inputRef}
            className="pi-live-input"
            value={input}
            onChange={event => setInput(event.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={event => {
              if (composing || event.nativeEvent.isComposing || event.keyCode === 229) return
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send(event.altKey ? 'followUp' : undefined)
              }
            }}
            placeholder={state?.isStreaming ? '继续指导 Pi…' : '输入任务，让 Pi 开始工作…'}
            aria-label="Pi 输入"
          />
          <div className="pi-live-compose-bar">
            <span className="pi-live-compose-runtime">{connected ? '实时已连接' : '正在重连'}</span>
            <div className="pi-live-compose-settings">
              <select
                aria-label="Pi 模型"
                title="Pi 模型"
                value={selectedModel}
                disabled={controlBusy || controls.models.length === 0}
                onChange={event => void changeModel(event.target.value)}
              >
                {!selectedModel && <option value="">模型</option>}
                {controls.models.map(item => <option key={`${item.provider}/${item.id}`} value={JSON.stringify([item.provider, item.id])}>{item.name || item.id} · {item.provider}</option>)}
              </select>
              <select
                aria-label="Pi Thinking Level"
                title="Pi Thinking Level"
                value={state?.thinkingLevel ?? ''}
                disabled={controlBusy || controls.thinkingLevels.length === 0}
                onChange={event => void changeThinkingLevel(event.target.value)}
              >
                {!state?.thinkingLevel && <option value="">Thinking</option>}
                {controls.thinkingLevels.map(level => <option key={level} value={level}>Thinking · {level}</option>)}
              </select>
            </div>
            <div className="pi-live-compose-mode" aria-label="发送方式">
              <button className={mode === 'steer' ? 'active' : ''} aria-pressed={mode === 'steer'} onClick={() => { setMode('steer'); inputRef.current?.focus({ preventScroll: true }) }}>立即介入</button>
              <button className={mode === 'followUp' ? 'active' : ''} aria-pressed={mode === 'followUp'} onClick={() => { setMode('followUp'); inputRef.current?.focus({ preventScroll: true }) }}>完成后继续</button>
            </div>
            <button className="pi-live-send" disabled={!input.trim() || busy || Boolean(extension)} onClick={() => void send()} aria-label="发送">↑</button>
          </div>
          <div className="pi-live-compose-hint">Enter {state?.isStreaming ? (mode === 'steer' ? '立即介入' : '按当前模式发送') : '开始新一轮'} · Alt+Enter 完成后继续 · Shift+Enter 换行</div>
        </div>
        {diagnostics && <div className="pi-live-diagnostics" title="Pi Live Web 调度诊断">事件 {diagnostics.ingressEvents} · 合并 {diagnostics.coalescedEvents} · 峰值队列 {diagnostics.maxQueueDepth} · 最近提交 {diagnostics.lastFlushLatencyMs.toFixed(1)}ms{diagnostics.hidden ? ' · 后台降频' : ''}</div>}
      </div>
    </TaskSurface>
  </main>
}