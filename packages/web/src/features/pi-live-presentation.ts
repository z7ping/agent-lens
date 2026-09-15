export type PiLivePresentationMutation<T> = (current: T) => T

export interface PiLivePresentationDiagnostics {
  queuedMutations: number
  committedMutations: number
  commitCount: number
  maxQueueDepth: number
  lastApplyDurationMs: number
  maxApplyDurationMs: number
  longApplyCount: number
}

/**
 * Web-only presentation scheduler.
 *
 * Runtime/SSE events are still received in full and in order. Only React-facing
 * display mutations are grouped, so canonical event semantics stay unchanged.
 */
export class PiLivePresentationScheduler<T> {
  private queue: PiLivePresentationMutation<T>[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private diagnostics: PiLivePresentationDiagnostics = {
    queuedMutations: 0,
    committedMutations: 0,
    commitCount: 0,
    maxQueueDepth: 0,
    lastApplyDurationMs: 0,
    maxApplyDurationMs: 0,
    longApplyCount: 0,
  }

  constructor(
    private readonly commit: (mutation: PiLivePresentationMutation<T>) => void,
    private readonly delayMs = 48,
  ) {}

  push(mutation: PiLivePresentationMutation<T>): void {
    if (this.disposed) return
    this.queue.push(mutation)
    this.diagnostics.queuedMutations += 1
    this.diagnostics.maxQueueDepth = Math.max(this.diagnostics.maxQueueDepth, this.queue.length)
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.delayMs)
  }

  flush(): void {
    if (this.disposed || this.queue.length === 0) return
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const batch = this.queue
    this.queue = []
    this.diagnostics.committedMutations += batch.length
    this.diagnostics.commitCount += 1
    this.commit(current => {
      const startedAt = performance.now()
      let next = current
      for (const mutation of batch) next = mutation(next)
      const durationMs = Math.max(0, performance.now() - startedAt)
      this.diagnostics.lastApplyDurationMs = durationMs
      this.diagnostics.maxApplyDurationMs = Math.max(this.diagnostics.maxApplyDurationMs, durationMs)
      if (durationMs >= 16) this.diagnostics.longApplyCount += 1
      return next
    })
  }

  /**
   * Structural boundaries must be visible immediately, but pending deltas are
   * committed first so contentIndex order remains exactly the source order.
   */
  boundary(mutation: PiLivePresentationMutation<T>): void {
    if (this.disposed) return
    this.flush()
    this.diagnostics.committedMutations += 1
    this.diagnostics.commitCount += 1
    this.commit(mutation)
  }

  clear(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.queue = []
  }

  snapshot(): PiLivePresentationDiagnostics {
    return { ...this.diagnostics }
  }

  dispose(): void {
    if (this.disposed) return
    this.clear()
    this.disposed = true
  }
}
