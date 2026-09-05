import type { IncomingMessage, Server, ServerResponse } from 'node:http'

const DEFAULT_QUIET_MS = 500
const DEFAULT_POLL_MS = 100

interface ForegroundActivityGateOptions {
  quietMs?: number
  pollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export class ForegroundActivityGate {
  private readonly quietMs: number
  private readonly pollMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private activeRequests = 0
  private lastActivityAt: number

  constructor(options: ForegroundActivityGateOptions = {}) {
    this.quietMs = options.quietMs ?? DEFAULT_QUIET_MS
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.lastActivityAt = this.now()
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
    return this.activeRequests === 0 && this.now() - this.lastActivityAt >= this.quietMs
  }

  async wait(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.isIdle()) {
      await this.sleep(this.pollMs)
    }
  }

  snapshot(): { activeRequests: number; lastActivityAt: number } {
    return { activeRequests: this.activeRequests, lastActivityAt: this.lastActivityAt }
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
