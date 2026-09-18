import type {
  LiveAvailabilityDto,
  LiveCommandsResponseDto,
  LiveCommandDto,
  LiveInterruptResultDto,
  LiveMessageActionContributionDto,
  LiveMessageActionResultDto,
  LiveMessageActionsResponseDto,
  LiveMessageInputDto,
  LiveModelControlDto,
  LiveProductDto,
  LiveProductsResponseDto,
  LiveQueueStateDto,
  LiveRuntimeActionResultDto,
  LiveRuntimeDisclosureContributionDto,
  LiveRuntimeDisclosuresResponseDto,
  LiveRuntimeEventDto,
  LiveRuntimeRefDto,
  LiveRuntimeStateDto,
  LiveSnapshotDto,
  LiveStartInputDto,
  LiveThinkingControlDto,
  LiveWorkspaceFileReferenceDto,
  LiveWorkspaceFileReferencesResponseDto,
} from '@agent-lens/protocol'
import { shareInFlight } from './single-flight'

const liveReadInFlight = new Map<string, Promise<unknown>>()
const LIVE_ROOT = '/api/v1/live'

const LIVE_VISIBLE_FLUSH_MS = 48
const LIVE_HIDDEN_FLUSH_MS = 250

function liveEventType(value: LiveRuntimeEventDto): string {
  return value.normalizedEvent?.type ?? ''
}

function liveCoalesceKey(value: LiveRuntimeEventDto, messageEpoch: number): string | undefined {
  const event = value.normalizedEvent
  if (!event || (event.type !== 'text.delta' && event.type !== 'reasoning.delta')) return undefined
  const messageId = 'messageId' in event && event.messageId ? event.messageId : `epoch-${messageEpoch}`
  const contentIndex = 'contentIndex' in event ? event.contentIndex ?? 0 : 0
  return `${event.type}:${messageId}:${contentIndex}`
}

function mergeLiveCoalesced(previous: LiveRuntimeEventDto, next: LiveRuntimeEventDto): LiveRuntimeEventDto {
  const before = previous.normalizedEvent
  const after = next.normalizedEvent
  if (!before || !after || before.type !== after.type
    || (after.type !== 'text.delta' && after.type !== 'reasoning.delta')) return next
  return {
    ...next,
    normalizedEvent: {
      ...after,
      delta: `${before.delta ?? ''}${after.delta ?? ''}`,
    },
  }
}

function isLivePriorityEvent(value: LiveRuntimeEventDto): boolean {
  const type = liveEventType(value)
  return type !== 'text.delta' && type !== 'reasoning.delta' && type !== 'tool.output'
}

export interface LiveEventSchedulerDiagnostics {
  ingressEvents: number
  deliveredEvents: number
  coalescedEvents: number
  flushCount: number
  maxQueueDepth: number
  hidden: boolean
}

export class LiveEventScheduler {
  private queue: LiveRuntimeEventDto[] = []
  private readonly indexes = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private messageEpoch = 0
  private disposed = false
  private diagnostics: LiveEventSchedulerDiagnostics = {
    ingressEvents: 0,
    deliveredEvents: 0,
    coalescedEvents: 0,
    flushCount: 0,
    maxQueueDepth: 0,
    hidden: typeof document !== 'undefined' ? document.hidden : false,
  }

  constructor(private readonly deliver: (events: LiveRuntimeEventDto[]) => void) {}

  push(value: LiveRuntimeEventDto): void {
    if (this.disposed) return
    this.diagnostics.ingressEvents += 1
    if (value.normalizedEvent?.type === 'message.start') this.messageEpoch += 1

    const key = liveCoalesceKey(value, this.messageEpoch)
    const existing = key ? this.indexes.get(key) : undefined
    if (existing !== undefined) {
      this.queue[existing] = mergeLiveCoalesced(this.queue[existing]!, value)
      this.diagnostics.coalescedEvents += 1
    } else {
      const index = this.queue.push(value) - 1
      if (key) this.indexes.set(key, index)
      this.diagnostics.maxQueueDepth = Math.max(this.diagnostics.maxQueueDepth, this.queue.length)
    }
    this.schedule(isLivePriorityEvent(value))
  }

  visibilityChanged(): void {
    if (this.disposed) return
    this.diagnostics.hidden = typeof document !== 'undefined' ? document.hidden : false
    if (!this.queue.length) return
    this.cancelSchedule()
    this.schedule(false)
  }

  snapshot(): LiveEventSchedulerDiagnostics {
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
    this.deliver(batch)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelSchedule()
    this.queue = []
    this.indexes.clear()
  }

  private schedule(priority: boolean): void {
    if (priority) {
      this.cancelSchedule()
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, 0)
      return
    }
    if (this.timer !== null) return
    const hidden = typeof document !== 'undefined' && document.hidden
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, hidden ? LIVE_HIDDEN_FLUSH_MS : LIVE_VISIBLE_FLUSH_MS)
  }

  private cancelSchedule(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
}

function livePath(liveId: string, suffix = ''): string {
  return `${LIVE_ROOT}/${encodeURIComponent(liveId)}${suffix}`
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { message?: unknown; error?: unknown }
    if (typeof payload.message === 'string' && payload.message.trim()) return payload.message.trim()
    if (typeof payload.error === 'string' && payload.error.trim()) return payload.error.trim()
  } catch {
    // Fall through to the HTTP status below.
  }
  return `Live request failed (${response.status})`
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const execute = async () => {
    const response = await fetch(path, init)
    if (!response.ok) throw new Error(await readError(response))
    return await response.json() as T
  }
  const method = (init?.method ?? 'GET').toUpperCase()
  return method === 'GET'
    ? shareInFlight(liveReadInFlight, path, execute)
    : execute()
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function runtimeSuffix(runtimeSessionId: string, action = ''): string {
  return `/runtimes/${encodeURIComponent(runtimeSessionId)}${action}`
}

function notifyLiveStateChanged(liveId: string, runtimeSessionId?: string): void {
  window.dispatchEvent(new CustomEvent('agent-lens:live-state-changed', {
    detail: { liveId, ...(runtimeSessionId ? { runtimeSessionId } : {}) },
  }))
}

async function historyInteraction(
  liveId: string,
  logicalSessionId: string,
  action: 'resume' | 'fork',
): Promise<LiveRuntimeStateDto> {
  const state = await requestJson<LiveRuntimeStateDto>(
    livePath(liveId, `/history/${encodeURIComponent(logicalSessionId)}/${action}`),
    { method: 'POST' },
  )
  notifyLiveStateChanged(liveId, state.runtimeSessionId)
  return state
}

export const liveApi = {
  async products(): Promise<LiveProductDto[]> {
    return (await requestJson<LiveProductsResponseDto>(LIVE_ROOT)).items
  },

  async knownRuntimes(): Promise<LiveRuntimeRefDto[]> {
    const products = await this.products()
    return products.flatMap(product => product.runtimes.map(state => ({
      liveId: product.liveId,
      productId: product.productId,
      displayName: product.displayName,
      state,
    })))
  },

  availability(liveId: string): Promise<LiveAvailabilityDto> {
    return requestJson(livePath(liveId, '/availability'))
  },

  list(liveId: string): Promise<LiveRuntimeStateDto[]> {
    return requestJson(livePath(liveId, '/runtimes'))
  },


  async start(liveId: string, input: LiveStartInputDto = {}): Promise<LiveRuntimeStateDto> {
    const state = await requestJson<LiveRuntimeStateDto>(
      livePath(liveId, '/runtimes'),
      jsonRequest('POST', { input }),
    )
    notifyLiveStateChanged(liveId, state.runtimeSessionId)
    return state
  },

  resume(liveId: string, logicalSessionId: string): Promise<LiveRuntimeStateDto> {
    return historyInteraction(liveId, logicalSessionId, 'resume')
  },

  fork(liveId: string, logicalSessionId: string): Promise<LiveRuntimeStateDto> {
    return historyInteraction(liveId, logicalSessionId, 'fork')
  },

  state(liveId: string, runtimeSessionId: string): Promise<LiveRuntimeStateDto> {
    return requestJson(livePath(liveId, runtimeSuffix(runtimeSessionId, '/state')))
  },

  snapshot(liveId: string, runtimeSessionId: string, since?: string): Promise<LiveSnapshotDto> {
    const search = since ? `?since=${encodeURIComponent(since)}` : ''
    return requestJson(`${livePath(liveId, runtimeSuffix(runtimeSessionId, '/snapshot'))}${search}`)
  },

  async send(
    liveId: string,
    runtimeSessionId: string,
    message: LiveMessageInputDto,
    behavior?: 'normal' | 'steer' | 'follow-up',
  ): Promise<void> {
    await requestJson(
      livePath(liveId, runtimeSuffix(runtimeSessionId, '/messages')),
      jsonRequest('POST', { message, ...(behavior ? { behavior } : {}) }),
    )
  },

  async commands(liveId: string, runtimeSessionId: string): Promise<LiveCommandDto[]> {
    return (await requestJson<LiveCommandsResponseDto>(
      livePath(liveId, runtimeSuffix(runtimeSessionId, '/commands')),
    )).items
  },
  async messageActions(
    liveId: string,
    runtimeSessionId: string,
  ): Promise<LiveMessageActionContributionDto[]> {
    return (await requestJson<LiveMessageActionsResponseDto>(
      livePath(liveId, runtimeSuffix(runtimeSessionId, '/message-actions')),
    )).items
  },
  executeMessageAction(
    liveId: string,
    runtimeSessionId: string,
    actionId: string,
    targetEntryId: string,
  ): Promise<LiveMessageActionResultDto> {
    return requestJson(
      livePath(liveId, runtimeSuffix(runtimeSessionId, '/message-actions')),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actionId, targetEntryId }),
      },
    )
  },

  async runtimeDisclosures(
    liveId: string,
    runtimeSessionId: string,
  ): Promise<LiveRuntimeDisclosureContributionDto[]> {
    return (await requestJson<LiveRuntimeDisclosuresResponseDto>(
      livePath(liveId, runtimeSuffix(runtimeSessionId, '/runtime-disclosures')),
    )).items
  },
  executeRuntimeAction(
    liveId: string,
    runtimeSessionId: string,
    actionId: string,
  ): Promise<LiveRuntimeActionResultDto> {
    return requestJson(
      livePath(liveId, runtimeSuffix(runtimeSessionId, '/runtime-actions')),
      jsonRequest('POST', { actionId }),
    )
  },

  async workspaceFileReferences(
    liveId: string,
    runtimeSessionId: string,
    query: string,
    limit = 20,
  ): Promise<LiveWorkspaceFileReferenceDto[]> {
    const params = new URLSearchParams({
      q: query,
      limit: String(Math.max(1, Math.min(50, limit))),
    })
    return (await requestJson<LiveWorkspaceFileReferencesResponseDto>(
      `${livePath(liveId, runtimeSuffix(runtimeSessionId, '/workspace-references'))}?${params}`,
    )).items
  },

  queueState(liveId: string, runtimeSessionId: string): Promise<LiveQueueStateDto> {
    return requestJson(livePath(liveId, runtimeSuffix(runtimeSessionId, '/queue')))
  },

  clearQueue(liveId: string, runtimeSessionId: string): Promise<LiveQueueStateDto> {
    return requestJson(
      livePath(liveId, runtimeSuffix(runtimeSessionId, '/queue')),
      { method: 'DELETE' },
    )
  },

  interrupt(liveId: string, runtimeSessionId: string): Promise<LiveInterruptResultDto> {
    return requestJson(
      livePath(liveId, runtimeSuffix(runtimeSessionId, '/interrupt')),
      { method: 'POST' },
    )
  },

  modelControl(liveId: string, runtimeSessionId: string): Promise<LiveModelControlDto | null> {
    return requestJson(livePath(liveId, runtimeSuffix(runtimeSessionId, '/model-control')))
  },

  setModelControl(liveId: string, runtimeSessionId: string, value: string): Promise<LiveRuntimeStateDto> {
    return requestJson(
      livePath(liveId, runtimeSuffix(runtimeSessionId, '/model-control')),
      jsonRequest('POST', { value }),
    )
  },

  thinkingControl(liveId: string, runtimeSessionId: string): Promise<LiveThinkingControlDto | null> {
    return requestJson(livePath(liveId, runtimeSuffix(runtimeSessionId, '/thinking-control')))
  },

  setThinkingControl(liveId: string, runtimeSessionId: string, value: string): Promise<LiveRuntimeStateDto> {
    return requestJson(
      livePath(liveId, runtimeSuffix(runtimeSessionId, '/thinking-control')),
      jsonRequest('POST', { value }),
    )
  },

  async respondToExtension(liveId: string, runtimeSessionId: string, requestId: string, response: unknown): Promise<void> {
    await requestJson(
      livePath(liveId, runtimeSuffix(runtimeSessionId, '/extension-response')),
      jsonRequest('POST', { requestId, response }),
    )
  },

  async terminate(liveId: string, runtimeSessionId: string): Promise<void> {
    await requestJson(livePath(liveId, runtimeSuffix(runtimeSessionId)), { method: 'DELETE' })
    notifyLiveStateChanged(liveId, runtimeSessionId)
  },

  subscribe(
    liveId: string,
    runtimeSessionId: string,
    listener: (event: LiveRuntimeEventDto) => void,
    onError?: (event: Event) => void,
    onOpen?: (event: Event) => void,
  ): () => void {
    const source = new EventSource(livePath(liveId, runtimeSuffix(runtimeSessionId, '/events')))
    const scheduler = new LiveEventScheduler(events => {
      for (const value of events) listener(value)
    })
    const onVisibility = () => scheduler.visibilityChanged()
    const onLive = (event: MessageEvent<string>) => {
      try {
        scheduler.push(JSON.parse(event.data) as LiveRuntimeEventDto)
      } catch {
        // Ignore malformed transport payloads; the next valid event can still recover the stream.
      }
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
    source.addEventListener('live', onLive as EventListener)
    if (onError) source.addEventListener('error', onError)
    if (onOpen) source.addEventListener('open', onOpen)
    return () => {
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
      scheduler.dispose()
      source.close()
    }
  },
}
