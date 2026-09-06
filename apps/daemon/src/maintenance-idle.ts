import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { abortableDelay } from '@agent-lens/runtime-cordis'

const DEFAULT_QUIET_MS = 5_000
const DEFAULT_POLL_MS = 100
const DEFAULT_MAX_DEFER_MS = 5_000

export interface ForegroundLoadSnapshot {
  foregroundPending: number
  writerPending: number
}

export interface ForegroundActivityGateSnapshot {
  activeRequests: number
  lastActivityAt: number
  load: ForegroundLoadSnapshot
  policy: {
    quietMs: number
    pollMs: number
    maxDeferMs: number
  }
  permits: {
    quiet: number
    forced: number
    lastAt: number | null
    lastForcedAt: number | null
    maxWaitMs: number
  }
}

interface ForegroundActivityGateOptions {
  quietMs?: number
  pollMs?: number
  maxDeferMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  loadProbe?: () => ForegroundLoadSnapshot
}

export class ForegroundActivityGate {
  private readonly quietMs: number
  private readonly pollMs: number
  private readonly maxDeferMs: number
  private readonly now: () => number
  private readonly customSleep: ((ms: number) => Promise<void>) | undefined
  private loadProbe: (() => ForegroundLoadSnapshot) | null
  private activeRequests = 0
  private lastActivityAt: number
  private quietPermits = 0
  private forcedPermits = 0
  private lastPermitAt: number | null = null
  private lastForcedPermitAt: number | null = null
  private maxWaitMs = 0

  constructor(options: ForegroundActivityGateOptions = {}) {
    this.quietMs = options.quietMs ?? DEFAULT_QUIET_MS
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS
    this.maxDeferMs = options.maxDeferMs ?? DEFAULT_MAX_DEFER_MS
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

  private load(): ForegroundLoadSnapshot {
    return this.loadProbe?.() ?? { foregroundPending: 0, writerPending: 0 }
  }

  isIdle(): boolean {
    const load = this.load()
    return this.activeRequests === 0
      && load.foregroundPending === 0
      && load.writerPending === 0
      && this.now() - this.lastActivityAt >= this.quietMs
  }

  private canForcePermit(waitStartedAt: number, load: ForegroundLoadSnapshot): boolean {
    if (load.writerPending > 0) return false
    const now = this.now()
    if (now - waitStartedAt < this.maxDeferMs) return false
    return this.lastPermitAt === null || now - this.lastPermitAt >= this.maxDeferMs
  }

  private recordPermit(waitStartedAt: number, forced: boolean): void {
    const now = this.now()
    const waitedMs = Math.max(0, now - waitStartedAt)
    this.maxWaitMs = Math.max(this.maxWaitMs, waitedMs)
    this.lastPermitAt = now
    if (forced) {
      this.forcedPermits += 1
      this.lastForcedPermitAt = now
    } else {
      this.quietPermits += 1
    }
  }

  async wait(signal: AbortSignal): Promise<void> {
    const waitStartedAt = this.now()
    while (!signal.aborted) {
      if (this.isIdle()) {
        this.recordPermit(waitStartedAt, false)
        return
      }
      if (this.canForcePermit(waitStartedAt, this.load())) {
        this.recordPermit(waitStartedAt, true)
        return
      }
      if (this.customSleep) await this.customSleep(this.pollMs)
      else await abortableDelay(this.pollMs, signal)
    }
  }

  snapshot(): ForegroundActivityGateSnapshot {
    return {
      activeRequests: this.activeRequests,
      lastActivityAt: this.lastActivityAt,
      load: this.load(),
      policy: {
        quietMs: this.quietMs,
        pollMs: this.pollMs,
        maxDeferMs: this.maxDeferMs,
      },
      permits: {
        quiet: this.quietPermits,
        forced: this.forcedPermits,
        lastAt: this.lastPermitAt,
        lastForcedAt: this.lastForcedPermitAt,
        maxWaitMs: this.maxWaitMs,
      },
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
  DEFAULT_MAX_DEFER_MS,
}
