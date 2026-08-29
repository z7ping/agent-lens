import type {
  JsonValue,
  PiLiveAbortRequestDto,
  PiLiveAvailabilityDto,
  PiLiveEventDto,
  PiLiveExtensionResponseRequestDto,
  PiLivePromptRequestDto,
  PiLiveQueueDto,
  PiLiveSnapshotDto,
  PiLiveStartRequestDto,
  PiLiveStateDto,
  PiLiveStreamingBehaviorDto,
} from '@agent-lens/protocol'

const KNOWN_RUNTIME_KEY = 'agent-lens:pi-live-runtime-ids'
const HIDDEN_FLUSH_MS = 250
const MAX_KNOWN_RUNTIMES = 12

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { accept: 'application/json', ...(init.headers ?? {}) },
  })
  if (!response.ok) {
    let message = ''
    try {
      const body = await response.json() as { message?: unknown }
      if (typeof body.message === 'string') message = body.message
    } catch { /* ignore non-json error */ }
    throw new Error(message || `Pi Live 请求失败（${response.status}）`)
  }
  return response.json() as Promise<T>
}

function jsonRequest(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function readKnownRuntimeIds(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(KNOWN_RUNTIME_KEY) ?? '[]')
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && Boolean(item)).slice(0, MAX_KNOWN_RUNTIMES)
      : []
  } catch {
    return []
  }
}

function writeKnownRuntimeIds(ids: string[]): void {
  try { localStorage.setItem(KNOWN_RUNTIME_KEY, JSON.stringify([...new Set(ids)].slice(0, MAX_KNOWN_RUNTIMES))) } catch { /* storage unavailable */ }
}

function rememberRuntime(id: string): void {
  if (!id) return
  writeKnownRuntimeIds([id, ...readKnownRuntimeIds().filter(item => item !== id)])
}

function forgetRuntime(id: string): void {
  writeKnownRuntimeIds(readKnownRuntimeIds().filter(item => item !== id))
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function eventType(value: PiLiveEventDto): string {
  return typeof value.event.type === 'string' ? value.event.type : ''
}

function coalesceKey(value: PiLiveEventDto, messageEpoch: number): string | undefined {
  const type = eventType(value)
  const event = record(value.event)
  if (type === 'message_update') {
    const update = record(event.assistantMessageEvent)
    const updateType = typeof update.type === 'string' ? update.type : ''
    const index = typeof update.contentIndex === 'number' ? update.contentIndex : 0
    if (updateType === 'text_delta' || updateType === 'thinking_delta' || updateType === 'toolcall_delta') {
      return `message:${messageEpoch}:${updateType}:${index}`
    }
  }
  if (type === 'tool_execution_update') {
    const id = typeof event.toolCallId === 'string' ? event.toolCallId : ''
    return id ? `tool:${id}` : undefined
  }
  if (type === 'bash_execution_update') {
    const id = typeof event.id === 'string' ? event.id : 'direct'
    return `bash:${id}`
  }
  return undefined
}

function mergeCoalesced(previous: PiLiveEventDto, next: PiLiveEventDto): PiLiveEventDto {
  const type = eventType(next)
  if (type === 'message_update') {
    const previousEvent = record(previous.event)
    const nextEvent = record(next.event)
    const previousUpdate = record(previousEvent.assistantMessageEvent)
    const nextUpdate = record(nextEvent.assistantMessageEvent)
    const previousDelta = typeof previousUpdate.delta === 'string' ? previousUpdate.delta : ''
    const nextDelta = typeof nextUpdate.delta === 'string' ? nextUpdate.delta : ''
    return {
      ...next,
      event: {
        ...next.event,
        assistantMessageEvent: {
          ...nextUpdate,
          delta: `${previousDelta}${nextDelta}`,
        } as JsonValue,
      },
    }
  }
  if (type === 'bash_execution_update') {
    const previousDelta = typeof previous.event.delta === 'string' ? previous.event.delta : ''
    const nextDelta = typeof next.event.delta === 'string' ? next.event.delta : ''
    return { ...next, event: { ...next.event, delta: `${previousDelta}${nextDelta}` } }
  }
  // Pi tool_execution_update.partialResult is cumulative; latest value replaces earlier progress.
  return next
}

function isPriorityEvent(value: PiLiveEventDto): boolean {
  return [
    'extension_ui_request',
    'queue_update',
    'agent_settled',
    'agent_end',
    'tool_execution_start',
    'tool_execution_end',
    'compaction_start',
    'compaction_end',
    'auto_retry_start',
    'auto_retry_end',
    'extension_error',
    'runtime_exit',
  ].includes(eventType(value))
}

export interface PiLiveTransportDiagnostics {
  ingressEvents: number
  deliveredEvents: number
  coalescedEvents: number
  flushCount: number
  maxQueueDepth: number
  lastBatchSize: number
  lastFlushLatencyMs: number
  hidden: boolean
}

export class PiLiveEventScheduler {
  private queue: PiLiveEventDto[] = []
  private readonly indexes = new Map<string, number>()
  private frame: number | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private messageEpoch = 0
  private oldestQueuedAt = 0
  private disposed = false
  private diagnostics: PiLiveTransportDiagnostics = {
    ingressEvents: 0,
    deliveredEvents: 0,
    coalescedEvents: 0,
    flushCount: 0,
    maxQueueDepth: 0,
    lastBatchSize: 0,
    lastFlushLatencyMs: 0,
    hidden: typeof document !== 'undefined' ? document.hidden : false,
  }

  constructor(private readonly deliver: (events: PiLiveEventDto[], diagnostics: PiLiveTransportDiagnostics) => void) {}

  push(value: PiLiveEventDto): void {
    if (this.disposed) return
    this.diagnostics.ingressEvents += 1
    if (eventType(value) === 'message_start') this.messageEpoch += 1
    const key = coalesceKey(value, this.messageEpoch)
    const existing = key ? this.indexes.get(key) : undefined
    if (existing !== undefined) {
      this.queue[existing] = mergeCoalesced(this.queue[existing]!, value)
      this.diagnostics.coalescedEvents += 1
    } else {
      if (!this.queue.length) this.oldestQueuedAt = performance.now()
      const index = this.queue.push(value) - 1
      if (key) this.indexes.set(key, index)
      this.diagnostics.maxQueueDepth = Math.max(this.diagnostics.maxQueueDepth, this.queue.length)
    }
    this.schedule(isPriorityEvent(value))
  }

  visibilityChanged(): void {
    if (this.disposed) return
    this.diagnostics.hidden = document.hidden
    this.cancelSchedule()
    if (this.queue.length) this.schedule(false)
  }

  snapshot(): PiLiveTransportDiagnostics {
    return { ...this.diagnostics }
  }

  flush(): void {
    if (this.disposed || !this.queue.length) return
    this.cancelSchedule()
    const batch = this.queue
    this.queue = []
    this.indexes.clear()
    this.diagnostics.deliveredEvents += batch.length
    this.diagnostics.flushCount += 1
    this.diagnostics.lastBatchSize = batch.length
    this.diagnostics.lastFlushLatencyMs = Math.max(0, performance.now() - this.oldestQueuedAt)
    this.oldestQueuedAt = 0
    this.deliver(batch, this.snapshot())
  }

  dispose(): void {
    if (this.disposed) return
    this.flush()
    this.disposed = true
    this.cancelSchedule()
  }

  private schedule(priority: boolean): void {
    if (this.frame !== null || this.timer !== null) return
    if (priority) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, 0)
      return
    }
    if (typeof document !== 'undefined' && document.hidden) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, HIDDEN_FLUSH_MS)
      return
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      this.flush()
    })
  }

  private cancelSchedule(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    if (this.timer !== null) clearTimeout(this.timer)
    this.frame = null
    this.timer = null
  }
}

export interface PiLiveConnectionHandlers {
  onEvents(events: PiLiveEventDto[], diagnostics: PiLiveTransportDiagnostics): void
  onConnection(connected: boolean): void
  onSnapshot?(snapshot: PiLiveSnapshotDto): void
  onError?(error: Error): void
}

export class PiLiveApi {
  availability(): Promise<PiLiveAvailabilityDto> {
    return requestJson('/api/v1/pi-live/availability')
  }

  async knownRuntimes(): Promise<PiLiveStateDto[]> {
    const ids = readKnownRuntimeIds()
    const results = await Promise.allSettled(ids.map(id => this.state(id)))
    const values = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    writeKnownRuntimeIds(values.map(item => item.runtimeSessionId))
    return values
  }

  async start(input: PiLiveStartRequestDto): Promise<PiLiveStateDto> {
    const state = await requestJson<PiLiveStateDto>('/api/v1/pi-live', jsonRequest(input))
    rememberRuntime(state.runtimeSessionId)
    return state
  }

  state(runtimeSessionId: string): Promise<PiLiveStateDto> {
    return requestJson(`/api/v1/pi-live/${encodeURIComponent(runtimeSessionId)}/state`)
  }

  snapshot(runtimeSessionId: string, since?: string): Promise<PiLiveSnapshotDto> {
    const query = since ? `?since=${encodeURIComponent(since)}` : ''
    return requestJson(`/api/v1/pi-live/${encodeURIComponent(runtimeSessionId)}/snapshot${query}`)
  }

  prompt(runtimeSessionId: string, message: string, behavior?: PiLiveStreamingBehaviorDto): Promise<{ ok: true }> {
    const body: PiLivePromptRequestDto = { message, ...(behavior ? { behavior } : {}) }
    return requestJson(`/api/v1/pi-live/${encodeURIComponent(runtimeSessionId)}/prompt`, jsonRequest(body))
  }

  steer(runtimeSessionId: string, message: string): Promise<{ ok: true }> {
    return requestJson(`/api/v1/pi-live/${encodeURIComponent(runtimeSessionId)}/steer`, jsonRequest({ message }))
  }

  followUp(runtimeSessionId: string, message: string): Promise<{ ok: true }> {
    return requestJson(`/api/v1/pi-live/${encodeURIComponent(runtimeSessionId)}/follow-up`, jsonRequest({ message }))
  }

  abort(runtimeSessionId: string, restoreQueue = true): Promise<PiLiveQueueDto> {
    const body: PiLiveAbortRequestDto = { restoreQueue }
    return requestJson(`/api/v1/pi-live/${encodeURIComponent(runtimeSessionId)}/abort`, jsonRequest(body))
  }

  extensionResponse(runtimeSessionId: string, requestId: string, response: JsonValue): Promise<{ ok: true }> {
    const body: PiLiveExtensionResponseRequestDto = { requestId, response }
    return requestJson(`/api/v1/pi-live/${encodeURIComponent(runtimeSessionId)}/extension-response`, jsonRequest(body))
  }

  async terminate(runtimeSessionId: string): Promise<void> {
    await requestJson(`/api/v1/pi-live/${encodeURIComponent(runtimeSessionId)}`, { method: 'DELETE' })
    forgetRuntime(runtimeSessionId)
  }

  connect(runtimeSessionId: string, handlers: PiLiveConnectionHandlers): () => void {
    const source = new EventSource(`/api/v1/pi-live/${encodeURIComponent(runtimeSessionId)}/events`)
    const scheduler = new PiLiveEventScheduler(handlers.onEvents)
    let disposed = false
    let opened = false
    let reconnecting = false
    let leafId: string | undefined
    let recoveryGeneration = 0

    const recover = async () => {
      const generation = ++recoveryGeneration
      try {
        const snapshot = await this.snapshot(runtimeSessionId, leafId)
        if (disposed || generation !== recoveryGeneration) return
        if (snapshot.leafId) leafId = snapshot.leafId
        handlers.onSnapshot?.(snapshot)
      } catch (error) {
        if (!disposed) handlers.onError?.(error instanceof Error ? error : new Error(String(error)))
      }
    }

    const onVisibility = () => scheduler.visibilityChanged()
    document.addEventListener('visibilitychange', onVisibility)

    source.onopen = () => {
      if (disposed) return
      reconnecting = opened
      opened = true
      handlers.onConnection(true)
      if (reconnecting || !leafId) void recover()
    }
    source.onerror = () => {
      if (disposed) return
      handlers.onConnection(false)
    }
    source.addEventListener('pi-live', raw => {
      if (disposed) return
      try {
        const value = JSON.parse((raw as MessageEvent<string>).data) as PiLiveEventDto
        scheduler.push(value)
      } catch { /* malformed transport frame */ }
    })

    return () => {
      disposed = true
      recoveryGeneration += 1
      document.removeEventListener('visibilitychange', onVisibility)
      scheduler.dispose()
      source.close()
      handlers.onConnection(false)
    }
  }
}

export const piLiveApi = new PiLiveApi()
