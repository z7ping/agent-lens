import type { LiveRuntimeEvent } from '@agent-lens/core'

export type LiveRuntimeListener = (event: LiveRuntimeEvent) => void

export class LiveEventChannel {
  private readonly listeners = new Set<LiveRuntimeListener>()
  private sequence = 0

  constructor(
    readonly runtimeSessionId: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  subscribe(listener: LiveRuntimeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publish(event: Record<string, unknown>): LiveRuntimeEvent {
    this.sequence += 1
    const value: LiveRuntimeEvent = {
      runtimeSessionId: this.runtimeSessionId,
      sequence: this.sequence,
      receivedAt: this.now(),
      event,
    }
    for (const listener of this.listeners) listener(value)
    return value
  }

  clear(): void {
    this.listeners.clear()
  }

  get currentSequence(): number {
    return this.sequence
  }
}
