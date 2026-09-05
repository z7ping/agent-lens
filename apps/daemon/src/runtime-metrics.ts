import { monitorEventLoopDelay } from 'node:perf_hooks'

export interface EventLoopLagSnapshot {
  resolutionMs: number
  minMs: number
  maxMs: number
  meanMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
}

function milliseconds(nanoseconds: number): number {
  if (!Number.isFinite(nanoseconds) || nanoseconds <= 0) return 0
  return nanoseconds / 1_000_000
}

export class RuntimeMetrics {
  private readonly eventLoop
  private enabled = false

  constructor(private readonly resolutionMs = 20) {
    this.eventLoop = monitorEventLoopDelay({ resolution: resolutionMs })
  }

  start(): void {
    if (this.enabled) return
    this.enabled = true
    this.eventLoop.enable()
  }

  snapshot(): { eventLoopLag: EventLoopLagSnapshot } {
    return {
      eventLoopLag: {
        resolutionMs: this.resolutionMs,
        minMs: milliseconds(this.eventLoop.min),
        maxMs: milliseconds(this.eventLoop.max),
        meanMs: milliseconds(this.eventLoop.mean),
        p50Ms: milliseconds(this.eventLoop.percentile(50)),
        p95Ms: milliseconds(this.eventLoop.percentile(95)),
        p99Ms: milliseconds(this.eventLoop.percentile(99)),
      },
    }
  }

  stop(): void {
    if (!this.enabled) return
    this.enabled = false
    this.eventLoop.disable()
  }
}

export const runtimeMetricsInternals = { milliseconds }
