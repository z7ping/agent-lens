import type { InsightsResponseDto, LiveUpdateEventDto } from '@agent-lens/protocol'
import { AgentLensApi, type QueryFilters } from './api'

export interface InsightsClientSnapshot {
  filters: QueryFilters
  response: InsightsResponseDto | null
  loading: boolean
  hasNewData: boolean
  liveConnected: boolean
  error: string
}

type Listener = () => void

export class InsightsClientModel {
  private snapshot: InsightsClientSnapshot = {
    filters: { sourceId: '', projectId: '', range: '30d' },
    response: null,
    loading: true,
    hasNewData: false,
    liveConnected: false,
    error: '',
  }
  private readonly listeners = new Set<Listener>()
  private unsubscribeLive: (() => void) | null = null
  private generation = 0
  private invalidation = 0

  constructor(private readonly api = new AgentLensApi()) {}

  getSnapshot = (): InsightsClientSnapshot => this.snapshot

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(next: InsightsClientSnapshot): void {
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }

  async start(): Promise<void> {
    if (!this.unsubscribeLive) {
      this.unsubscribeLive = this.api.subscribe(
        event => this.onLiveEvent(event),
        connected => this.publish({ ...this.snapshot, liveConnected: connected }),
      )
    }
    await this.refresh()
  }

  stop(): void {
    this.unsubscribeLive?.()
    this.unsubscribeLive = null
  }

  setFilters(patch: Partial<QueryFilters>): void {
    this.publish({
      ...this.snapshot,
      filters: { ...this.snapshot.filters, ...patch },
    })
    void this.refresh()
  }

  async refresh(): Promise<void> {
    const generation = ++this.generation
    const invalidation = this.invalidation
    const filters = this.snapshot.filters
    this.publish({ ...this.snapshot, loading: true, error: '' })
    try {
      const response = await this.api.insights(filters)
      if (generation !== this.generation) return
      this.publish({
        ...this.snapshot,
        response,
        loading: false,
        hasNewData: this.invalidation !== invalidation,
        error: '',
      })
    } catch (error) {
      if (generation !== this.generation) return
      this.publish({
        ...this.snapshot,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private onLiveEvent(event: LiveUpdateEventDto): void {
    if (!event.affected.includes('insights')) return
    this.invalidation += 1
    if (!this.snapshot.hasNewData) {
      this.publish({ ...this.snapshot, hasNewData: true })
    }
  }
}
