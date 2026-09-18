import type {
  LiveAvailabilityDto,
  LiveInterruptResultDto,
  LiveMessageInputDto,
  LiveModelControlDto,
  LiveProductDto,
  LiveProductsResponseDto,
  LiveQueueStateDto,
  LiveRuntimeEventDto,
  LiveRuntimeRefDto,
  LiveRuntimeStateDto,
  LiveSnapshotDto,
  LiveStartInputDto,
  LiveThinkingControlDto,
} from '@agent-lens/protocol'
import { shareInFlight } from './single-flight'

const liveReadInFlight = new Map<string, Promise<unknown>>()
const LIVE_ROOT = '/api/v1/live'

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
    const onLive = (event: MessageEvent<string>) => {
      try {
        listener(JSON.parse(event.data) as LiveRuntimeEventDto)
      } catch {
        // Ignore malformed transport payloads; the next valid event can still recover the stream.
      }
    }
    source.addEventListener('live', onLive as EventListener)
    if (onError) source.addEventListener('error', onError)
    if (onOpen) source.addEventListener('open', onOpen)
    return () => source.close()
  },
}
