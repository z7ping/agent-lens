import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { abortableDelay } from '@agent-lens/runtime-cordis'

const DEFAULT_QUIET_MS = 5_000
const DEFAULT_POLL_MS = 100

export interface ForegroundLoadSnapshot {
  foregroundPending: number
  writerPending: number
}

interface ForegroundActivityGateOptions {
  quietMs?: number
  pollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  loadProbe?: () => ForegroundLoadSnapshot
}

export class ForegroundActivityGate {
  private readonly quietMs: number
  private readonly pollMs: number
  private readonly now: () => number
  private readonly customSleep?: (ms: number) => Promise<void>
  private loadProbe: (() => ForegroundLoadSnapshot) | null
  private activeRequests = 0
  private lastActivityAt: number

  constructor(options: ForegroundActivityGateOptions = {}) {
    this.quietMs = options.quietMs ?? DEFAULT_QUIET_MS
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS
    this.now = options.now ?? Date.now
    this.customSleep = options.sleep
    this.loadProbe = options.loadProbe ?? null
    this.lastActivityAt = this.now()
  }

  setLoadProbe(loadProbe: (() => ForegroundLoadSnapshot) | null): void {
    this.loadProbe = loadProbe
  }

  begin(): () => void {
    this.activeRequests += 1
    this.lastActivityAt = this.now()
    let ended = false
    return () => {
      if (ended) return
      ended = true
      this.activeRequests = Math.max(0, this.activeRequests - 1)
      this.lastActivityAt = this.now()
    }
  }

  isIdle(): boolean {
    const load = this.loadProbe?.() ?? { foregroundPending: 0, writerPending: 0 }
    return this.activeRequests === 0
      && load.foregroundPending === 0
      && load.writerPending === 0
      && this.now() - this.lastActivityAt >= this.quietMs
  }

  async wait(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.isIdle()) {
      if (this.customSleep) await this.customSleep(this.pollMs)
      else await abortableDelay(this.pollMs, signal)
    }
  }

  snapshot(): { activeRequests: number; lastActivityAt: number; load: ForegroundLoadSnapshot } {
    return {
      activeRequests: this.activeRequests,
      lastActivityAt: this.lastActivityAt,
      load: this.loadProbe?.() ?? { foregroundPending: 0, writerPending: 0 },
    }
  }
}

export function attachHttpForegroundActivity(
  server: Server,
  gate: ForegroundActivityGate,
): () => void {
  const onRequest = (request: IncomingMessage, response: ServerResponse) => {
    // SSE 是长期连接，但连接建立后不会持续占用 SQLite 前台请求通道。
    if ((request.url ?? '').startsWith('/api/v1/events')) return
    const end = gate.begin()
    response.once('finish', end)
    response.once('close', end)
  }
  server.on('request', onRequest)
  return () => server.off('request', onRequest)
}

export const maintenanceIdleInternals = {
  DEFAULT_QUIET_MS,
  DEFAULT_POLL_MS,
}
