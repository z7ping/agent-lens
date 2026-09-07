import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import {
  DATA_RUNTIME_DEFAULT_TIMEOUT_MS,
  DATA_RUNTIME_MAX_MESSAGE_BYTES,
  DATA_RUNTIME_MAX_PENDING_REQUESTS,
  DATA_RUNTIME_PROTOCOL_VERSION,
  encodedMessageBytes,
  isDataRuntimeReply,
  type DataRuntimeMethod,
  type DataRuntimeRequest,
  type DataRuntimeRole,
} from './protocol.js'

const METRIC_SAMPLE_LIMIT = 128
const HEARTBEAT_INTERVAL_MS = 5_000
const HEARTBEAT_TIMEOUT_MS = 15_000
const MIN_EXPLICIT_HEARTBEAT_MS = 50

function pushSample(samples: number[], value: number): void {
  samples.push(value)
  if (samples.length > METRIC_SAMPLE_LIMIT) samples.shift()
}
function percentile(samples: readonly number[], ratio: number): number {
  if (!samples.length) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0
}

function heartbeatDuration(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : Math.max(MIN_EXPLICIT_HEARTBEAT_MS, value)
}

export type DataRuntimeClientState = 'starting' | 'ready' | 'degraded' | 'stopped'

export interface DataRuntimeClientSnapshot {
  state: DataRuntimeClientState
  role: DataRuntimeRole
  protocolVersion: number
  pending: number
  maxPending: number
  requests: number
  completed: number
  timeouts: number
  livenessFailures: number
  lastError?: string
  durationMs: { last: number; max: number; p50: number; p95: number; p99: number }
}

interface PendingRequest {
  startedAt: number
  timer: NodeJS.Timeout
  resolve(value: unknown): void
  reject(error: Error): void
}

export interface DataRuntimeClientOptions {
  workerUrl?: URL
  requestTimeoutMs?: number
  allowDiagnostics?: boolean
  role?: DataRuntimeRole
  dbPath?: string
  nodeId?: string
  heartbeatIntervalMs?: number
  heartbeatTimeoutMs?: number
}

export function resolveDataRuntimeWorkerUrl(moduleUrl = import.meta.url): URL {
  return moduleUrl.endsWith('.mjs')
    ? new URL('./data-runtime-worker.mjs', moduleUrl)
    : new URL('./worker-source.mjs', moduleUrl)
}

export class DataRuntimeClient {
  private worker: Worker | null = null
  private stateValue: DataRuntimeClientState = 'stopped'
  private readonly pending = new Map<string, PendingRequest>()
  private maxPending = 0
  private requests = 0
  private completed = 0
  private timeouts = 0
  private livenessFailures = 0
  private lastError: string | undefined
  private lastDurationMs = 0
  private maxDurationMs = 0
  private readonly durations: number[] = []
  private stopping = false
  private heartbeatTimer: NodeJS.Timeout | null = null
  private heartbeatInFlight = false
  readonly role: DataRuntimeRole

  constructor(private readonly options: DataRuntimeClientOptions = {}) {
    this.role = options.role ?? 'writer'
  }

  async start(): Promise<void> {
    if (this.worker && this.stateValue !== 'stopped') return
    this.stopHeartbeat()
    this.stopping = false
    this.stateValue = 'starting'
    this.lastError = undefined
    const workerUrl = this.options.workerUrl ?? resolveDataRuntimeWorkerUrl()
    const worker = new Worker(workerUrl, {
      workerData: {
        allowDiagnostics: this.options.allowDiagnostics === true,
        role: this.role,
        ...(this.options.dbPath ? { dbPath: this.options.dbPath } : {}),
        ...(this.options.nodeId ? { nodeId: this.options.nodeId } : {}),
      },
      execArgv: [],
    })
    this.worker = worker
    worker.on('message', value => this.handleMessage(value))
    worker.on('error', error => this.markDegraded(error))
    worker.on('exit', code => {
      this.stopHeartbeat()
      if (this.worker === worker) this.worker = null
      if (this.stopping) {
        this.stateValue = 'stopped'
      } else {
        this.markDegraded(new Error(`Data Runtime ${this.role} worker exited unexpectedly with code ${code}`))
      }
      this.rejectAll(new Error(`Data Runtime ${this.role} worker is unavailable`))
    })

    try {
      await this.requestInternal('ping', undefined, Math.max(10_000, this.options.requestTimeoutMs ?? 0), true)
      this.stateValue = 'ready'
      this.startHeartbeat()
    } catch (error) {
      this.markDegraded(error)
      throw error
    }
  }

  state(): DataRuntimeClientState {
    return this.stateValue
  }

  snapshot(): DataRuntimeClientSnapshot {
    return {
      state: this.stateValue,
      role: this.role,
      protocolVersion: DATA_RUNTIME_PROTOCOL_VERSION,
      pending: this.pending.size,
      maxPending: this.maxPending,
      requests: this.requests,
      completed: this.completed,
      timeouts: this.timeouts,
      livenessFailures: this.livenessFailures,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      durationMs: {
        last: this.lastDurationMs,
        max: this.maxDurationMs,
        p50: percentile(this.durations, 0.5),
        p95: percentile(this.durations, 0.95),
        p99: percentile(this.durations, 0.99),
      },
    }
  }

  request<T = unknown>(
    method: DataRuntimeMethod,
    params?: Record<string, unknown>,
    timeoutMs = this.options.requestTimeoutMs ?? DATA_RUNTIME_DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    return this.requestInternal(method, params, timeoutMs, false)
  }

  async shutdown(): Promise<void> {
    this.stopHeartbeat()
    const worker = this.worker
    if (!worker) {
      this.stateValue = 'stopped'
      return
    }
    this.stopping = true
    try {
      await this.requestInternal('shutdown', undefined, 1_000, false).catch(() => undefined)
    } finally {
      await worker.terminate().catch(() => undefined)
      if (this.worker === worker) this.worker = null
      this.stateValue = 'stopped'
      this.rejectAll(new Error(`Data Runtime ${this.role} worker stopped`))
    }
  }

  private requestInternal<T = unknown>(
    method: DataRuntimeMethod,
    params: Record<string, unknown> | undefined,
    timeoutMs: number,
    fatalTimeout: boolean,
  ): Promise<T> {
    const worker = this.worker
    if (!worker) return Promise.reject(new Error(`Data Runtime ${this.role} worker is not started`))
    if (this.pending.size >= DATA_RUNTIME_MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error(`Data Runtime ${this.role} IPC pending request limit reached`))
    }

    const requestId = randomUUID()
    const request: DataRuntimeRequest = {
      protocolVersion: DATA_RUNTIME_PROTOCOL_VERSION,
      type: 'request',
      requestId,
      method,
      ...(params ? { params } : {}),
    }
    if (encodedMessageBytes(request) > DATA_RUNTIME_MAX_MESSAGE_BYTES) {
      return Promise.reject(new Error(`Data Runtime ${this.role} IPC request exceeds size limit`))
    }

    this.requests += 1
    this.maxPending = Math.max(this.maxPending, this.pending.size + 1)
    return new Promise<T>((resolve, reject) => {
      const startedAt = performance.now()
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId)
        if (!pending) return
        this.pending.delete(requestId)
        this.timeouts += 1
        const error = new Error(`Data Runtime ${this.role} request timed out: ${method}`)
        this.lastError = error.message
        reject(error)

        // Ordinary query timeouts are request-local. A slow SQL must not kill the
        // shared foreground Reader and fail unrelated requests. Only explicit
        // liveness probes are allowed to recycle a Worker.
        if (fatalTimeout && !this.stopping && this.worker === worker) {
          this.livenessFailures += 1
          this.markDegraded(error)
          void worker.terminate().catch(() => undefined)
        }
      }, Math.max(1, timeoutMs))
      timer.unref?.()
      this.pending.set(requestId, { startedAt, timer, resolve, reject })
      worker.postMessage(request)
    })
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer || this.stopping) return
    const intervalMs = heartbeatDuration(this.options.heartbeatIntervalMs, HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer = setInterval(() => {
      if (this.stopping || this.stateValue !== 'ready' || this.heartbeatInFlight) return
      this.heartbeatInFlight = true
      void this.requestInternal(
        'ping',
        undefined,
        heartbeatDuration(this.options.heartbeatTimeoutMs, HEARTBEAT_TIMEOUT_MS),
        true,
      ).catch(() => undefined).finally(() => {
        this.heartbeatInFlight = false
      })
    }, intervalMs)
    this.heartbeatTimer.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    this.heartbeatInFlight = false
  }

  private handleMessage(value: unknown): void {
    if (!isDataRuntimeReply(value)) return
    const pending = this.pending.get(value.requestId)
    if (!pending) return
    this.pending.delete(value.requestId)
    clearTimeout(pending.timer)
    const duration = performance.now() - pending.startedAt
    this.lastDurationMs = duration
    this.maxDurationMs = Math.max(this.maxDurationMs, duration)
    pushSample(this.durations, duration)
    this.completed += 1

    if (value.type === 'error') {
      const error = new Error(`${value.error.code}: ${value.error.message}`)
      this.lastError = error.message
      pending.reject(error)
    } else {
      pending.resolve(value.result)
    }
  }

  private markDegraded(error: unknown): void {
    this.stateValue = 'degraded'
    this.lastError = error instanceof Error ? error.message : String(error)
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
