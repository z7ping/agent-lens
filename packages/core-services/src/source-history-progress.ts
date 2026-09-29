import { randomUUID } from 'node:crypto'
import type { SourceHistoryProgressUpdate, SourceRuntimeStatus, SourceSyncProgress, SourceSyncState, SourceSyncStepId, StorageService } from '@agent-lens/core'

const STEP_IDS: SourceSyncStepId[] = ['detected', 'waiting', 'scanning', 'processing', 'checkpoint', 'finished']
const FLUSH_MS = 1_000
const HEARTBEAT_MS = 10_000

export function queuedHistoryStatus(sourceId: string, installationId: string, runtimeProfileId?: string): SourceRuntimeStatus {
  const now = new Date().toISOString()
  const progress: SourceSyncProgress = {
    version: 1, kind: 'source-history-sync', runId: randomUUID(),
    ownerStartedAt: new Date(performance.timeOrigin).toISOString(),
    state: 'pending', updatedAt: now, heartbeatAt: now,
    steps: STEP_IDS.map(id => id === 'detected'
      ? { id, state: 'completed', completedAt: now }
      : id === 'waiting' ? { id, state: 'running', startedAt: now } : { id, state: 'pending' }),
    records: 0, created: 0, merged: 0, unchanged: 0,
  }
  return {
    sourceId, installationId, ...(runtimeProfileId ? { runtimeProfileId } : {}),
    stage: 'history', state: 'idle', lastStartedAt: now, errorCount: 0, checkpointSummary: JSON.stringify(progress),
  }
}

/** 单个同步执行的有界摘要，阶段立即写入，计数最多每秒写入一次。 */
export class SourceHistoryProgressTracker {
  readonly progress: SourceSyncProgress
  private lastFlush = 0
  private tail: Promise<void> = Promise.resolve()
  private heartbeat: ReturnType<typeof setInterval> | undefined

  constructor(private readonly storage: StorageService, readonly status: SourceRuntimeStatus, private readonly onProgress?: () => void) {
    this.progress = JSON.parse(status.checkpointSummary!) as SourceSyncProgress
  }

  async begin(): Promise<void> {
    this.status.state = 'running'
    this.status.lastStartedAt = new Date().toISOString()
    this.progress.state = 'running'
    await this.phase('scanning')
    this.heartbeat = setInterval(() => {
      // 活着与有进展是两种事实，心跳不能刷新 updatedAt。
      this.progress.heartbeatAt = new Date().toISOString()
      void this.persist().catch(() => undefined)
    }, HEARTBEAT_MS)
    this.heartbeat.unref()
  }

  async phase(id: SourceSyncStepId): Promise<void> {
    const now = new Date().toISOString()
    const index = STEP_IDS.indexOf(id)
    const active = this.progress.steps.find(step => step.state === 'running')
    if (active?.id === id) return
    if (active && STEP_IDS.indexOf(active.id) > index) return
    if (active) { active.state = 'completed'; active.completedAt = now }
    const step = this.progress.steps[index]!
    step.state = 'running'
    step.startedAt = now
    this.progress.updatedAt = now
    await this.persist()
  }

  async report(update: SourceHistoryProgressUpdate): Promise<void> {
    if (update.discoveredUnits !== undefined) this.progress.discoveredUnits = update.discoveredUnits
    if (update.processedUnits !== undefined) this.progress.processedUnits = update.processedUnits
    if (update.currentUnit !== undefined) this.progress.currentUnit = update.currentUnit
    this.progress.updatedAt = new Date().toISOString()
    await this.phase(update.phase)
    await this.flush()
  }

  async record(result: { records: number; observationsCreated: number; observationsMerged: number; observationsUnchanged: number }): Promise<void> {
    await this.phase('processing')
    Object.assign(this.progress, {
      records: result.records, created: result.observationsCreated,
      merged: result.observationsMerged, unchanged: result.observationsUnchanged,
      updatedAt: new Date().toISOString(),
    })
    await this.flush()
  }

  async settle(state: Extract<SourceSyncState, 'completed' | 'failed' | 'cancelled'>, error?: string): Promise<void> {
    this.dispose()
    const now = new Date().toISOString()
    const active = this.progress.steps.find(step => step.state === 'running')
      ?? (state === 'failed' ? this.progress.steps.find(step => step.id === 'finished') : undefined)
    if (active) { active.state = state; active.completedAt = now }
    if (state === 'completed') {
      const finished = this.progress.steps.find(step => step.id === 'finished')!
      finished.state = 'completed'; finished.completedAt = now
      this.status.state = 'healthy'; this.status.lastSuccessAt = now
    } else if (state === 'failed') {
      this.status.state = 'failed'; this.status.lastErrorAt = now
      this.status.lastErrorSummary = error ?? '历史同步失败'
    } else this.status.state = 'idle'
    this.progress.state = state
    this.progress.updatedAt = now
    this.progress.heartbeatAt = now
    delete this.progress.currentUnit
    await this.persist()
  }

  dispose(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }

  private async flush(): Promise<void> {
    if (Date.now() - this.lastFlush >= FLUSH_MS) await this.persist()
  }

  private persist(): Promise<void> {
    this.lastFlush = Date.now()
    this.status.checkpointSummary = JSON.stringify(this.progress)
    const snapshot = { ...this.status }
    const pending = this.tail.catch(() => undefined).then(async () => {
      await this.storage.sourceRuntimeStatus?.put(snapshot)
      try { this.onProgress?.() } catch { /* 观察者失败不改变同步执行结果。 */ }
    })
    this.tail = pending
    return pending
  }
}
