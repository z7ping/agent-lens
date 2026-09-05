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
} from './protocol.js'

const METRIC_SAMPLE_LIMIT = 128

function pushSample(samples: number[], value: number): void {
  samples.push(value)
  if (samples.length > METRIC_SAMPLE_LIMIT) samples.shift()
}

function percentile(samples: readonly number[], ratio: number): number {
  if (!samples.length) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0
}

export type DataRuntimeClientState = 'starting' | 'ready' | 'degraded' | 'stopped'

export interface DataRuntimeClientSnapshot {
  state: DataRuntimeClientState
  protocolVersion: number
  pending: number
  maxPending: number
  requests: number
  completed: number
  timeouts: number
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
}

export function resolveDataRuntimeWorkerUrl(moduleUrl = import.meta.url): URL {
  return moduleUrl.endsWith('.mjs')
    ? new URL('./data-runtime-worker.mjs', moduleUrl)
    : new URL('./worker.ts', moduleUrl)
}

export class DataRuntimeClient {
  private worker: Worker | null = null
  private stateValue: DataRuntimeClientState = 'stopped'
  private readonly pending = new Map<string, PendingRequest>()
  private maxPending = 0
  private requests = 0
  private completed = 0
  private timeouts = 0
  private lastError: string | undefined
  private lastDurationMs = 0
  private maxDurationMs = 0
  private readonly durations: number[] = []
  private stopping = false

  constructor(private readonly options: DataRuntimeClientOptions = {}) {}

  async start(): Promise<void> {
    if (this.worker && this.stateValue !== 'stopped') return
    this.stopping = false
    this.stateValue = 'starting'
    this.lastError = undefined
    const workerUrl = this.options.workerUrl ?? resolveDataRuntimeWorkerUrl()
    const bundled = workerUrl.pathname.endsWith('.mjs')
    const worker = new Worker(workerUrl, {
      workerData: { allowDiagnostics: this.options.allowDiagnostics === true },
      ...(bundled ? { execArgv: [] } : { execArgv: ['--import', 'tsx'] }),
    })
    this.worker = worker
    worker.on('message', value => this.handleMessage(value))
    worker.on('error', error => this.markDegraded(error))
    worker.on('exit', code => {
      this.worker = null
      if (this.stopping) {
        this.stateValue = 'stopped'
      } else {
        this.markDegraded(new Error(`Data Runtime worker exited unexpectedly with code ${code}`))
      }
      this.rejectAll(new Error('Data Runtime worker is unavailable'))
    })

    try {
      await this.request('ping')
      this.stateValue = 'ready'
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
      protocolVersion: DATA_RUNTIME_PROTOCOL_VERSION,
      pending: this.pending.size,
      maxPending: this.maxPending,
      requests: this.requests,
      completed: this.completed,
      timeouts: this.timeouts,
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

  async request<T = unknown>(
    method: DataRuntimeMethod,
    params?: Record<string, unknown>,
    timeoutMs = this.options.requestTimeoutMs ?? DATA_RUNTIME_DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    const worker = this.worker
    if (!worker) throw new Error('Data Runtime worker is not started')
    if (this.pending.size >= DATA_RUNTIME_MAX_PENDING_REQUESTS) {
      throw new Error('Data Runtime IPC pending request limit reached')
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
      throw new Error('Data Runtime IPC request exceeds size limit')
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
        const error = new Error(`Data Runtime request timed out: ${method}`)
        this.lastError = error.message
        reject(error)
      }, Math.max(1, timeoutMs))
      timer.unref?.()
      this.pending.set(requestId, {
        startedAt,
        timer,
        resolve,
        reject,
      })
      worker.postMessage(request)
    })
  }

  async shutdown(): Promise<void> {
    const worker = this.worker
    if (!worker) {
      this.stateValue = 'stopped'
      return
    }
    this.stopping = true
    try {
      await this.request('shutdown', undefined, 1_000).catch(() => undefined)
    } finally {
      await worker.terminate().catch(() => undefined)
      this.worker = null
      this.stateValue = 'stopped'
      this.rejectAll(new Error('Data Runtime worker stopped'))
    }
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

export const dataRuntimeClientInternals = {
  percentile,
  METRIC_SAMPLE_LIMIT,
}
