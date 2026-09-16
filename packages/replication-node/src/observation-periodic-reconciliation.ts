import {
  reconcileReplicationPage,
  type HistoryBoundary,
  type KnownReplicationEntityType,
  type ReplicationPolicy,
  type ReplicationReconciliationSink,
} from '@agent-lens/core/replication'
import type { CanonicalReplicationReader } from './canonical-graph'
import {
  createObservationReconciliationSource,
} from './observation-reconciliation'
import type {
  CanonicalChangeSource,
} from './observation-change-pump'
import type {
  CanonicalObservationSnapshotSource,
  ObservationCaptureProgressStore,
} from './observation-snapshot-bootstrap'
import type {
  ObservationIncrementalProgress,
  ObservationIncrementalProgressStore,
} from './observation-incremental'

export interface ObservationPeriodicReconciliationCycle {
  streamId: string
  generationId: string
  entityType: KnownReplicationEntityType
  cycle: number
  status: 'idle' | 'running'
  throughRevision: number
  startedAt?: string
  completedAt?: string
  nextDueAt?: string
  updatedAt: string
}

export interface ObservationPeriodicReconciliationCycleStore {
  getReconciliationCycle(input: {
    streamId: string
    generationId: string
    entityType: KnownReplicationEntityType
  }): Promise<ObservationPeriodicReconciliationCycle | null>
  beginReconciliationCycle(input: {
    streamId: string
    generationId: string
    entityType: KnownReplicationEntityType
    throughRevision: number
    now?: string
  }): Promise<
    | { kind: 'running'; cycle: ObservationPeriodicReconciliationCycle }
    | { kind: 'not-due'; nextDueAt: string }
  >
  completeReconciliationCycle(input: {
    streamId: string
    generationId: string
    entityType: KnownReplicationEntityType
    nextDueAt: string
    now?: string
  }): Promise<ObservationPeriodicReconciliationCycle>
}

export type ObservationPeriodicReconciliationResult =
  | { kind: 'not-due'; nextDueAt: string }
  | {
      kind: 'running'
      cycle: number
      throughRevision: number
      scanned: number
      done: false
    }
  | {
      kind: 'completed'
      cycle: number
      throughRevision: number
      scanned: number
      nextDueAt: string
    }

function nextDueAt(now: string, intervalMs: number): string {
  const timestamp = Date.parse(now)
  if (!Number.isFinite(timestamp)) throw new Error('Periodic Reconciliation now must be a valid timestamp')
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError('Periodic Reconciliation intervalMs must be positive')
  }
  return new Date(timestamp + intervalMs).toISOString()
}

/**
 * Run one bounded page of the active-stream periodic Reconciliation cycle.
 *
 * A cycle fixes journal high-water before resetting its root cursor. Once the
 * full current CanonicalObservation graph has been durably enqueued, every
 * entity type reconstructed by that graph is safe through the fixed revision.
 * Changes committed after cycle start have a greater revision and remain in the
 * journal for the next incremental/reconciliation pass.
 */
export async function pumpObservationPeriodicReconciliationPage(input: {
  changes: CanonicalChangeSource
  snapshot: CanonicalObservationSnapshotSource
  dependencies: CanonicalReplicationReader
  sink: ReplicationReconciliationSink
  cycles: ObservationPeriodicReconciliationCycleStore
  captureProgress: ObservationCaptureProgressStore
  incrementalProgress: ObservationIncrementalProgressStore
  nodeId: string
  streamId: string
  generationId: string
  policy: ReplicationPolicy
  history: HistoryBoundary
  intervalMs: number
  limit?: number
  now?: string
}): Promise<ObservationPeriodicReconciliationResult> {
  const now = input.now ?? new Date().toISOString()
  const existingCycle = await input.cycles.getReconciliationCycle({
    streamId: input.streamId,
    generationId: input.generationId,
    entityType: 'CanonicalObservation',
  })
  if (
    existingCycle?.status === 'idle'
    && existingCycle.nextDueAt
    && Date.parse(existingCycle.nextDueAt) > Date.parse(now)
  ) {
    return { kind: 'not-due', nextDueAt: existingCycle.nextDueAt }
  }

  let cycle: ObservationPeriodicReconciliationCycle
  if (existingCycle?.status === 'running') {
    cycle = existingCycle
  } else {
    const highWater = await input.changes.highWaterRevision()
    const cycleResult = await input.cycles.beginReconciliationCycle({
      streamId: input.streamId,
      generationId: input.generationId,
      entityType: 'CanonicalObservation',
      throughRevision: highWater,
      ...(input.now === undefined ? {} : { now }),
    })
    if (cycleResult.kind === 'not-due') return cycleResult
    cycle = cycleResult.cycle
  }
  const source = createObservationReconciliationSource({
    snapshot: input.snapshot,
    dependencies: input.dependencies,
    nodeId: input.nodeId,
    streamId: input.streamId,
    generationId: input.generationId,
    policy: input.policy,
    history: input.history,
  })
  const result = await reconcileReplicationPage({
    source,
    sink: input.sink,
    streamId: input.streamId,
    generationId: input.generationId,
    entityType: 'CanonicalObservation',
    policyRevision: input.policy.revision,
    historyRevision: input.history.revision,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  })

  if (!result.done) {
    return {
      kind: 'running',
      cycle: cycle.cycle,
      throughRevision: cycle.throughRevision,
      scanned: result.scanned,
      done: false,
    }
  }

  const progressKey = {
    streamId: input.streamId,
    generationId: input.generationId,
    phase: 'incremental' as const,
    entityType: 'CanonicalObservation' as const,
  }
  const existing = await input.incrementalProgress.get(progressKey)
  if (!existing) {
    throw new Error('Periodic Reconciliation requires initialized incremental progress')
  }
  const next: ObservationIncrementalProgress = {
    ...existing,
    revision: Math.max(existing.revision, cycle.throughRevision),
    throughRevision: Math.max(existing.throughRevision, cycle.throughRevision),
    updatedAt: now,
  }
  // Persist the replay boundary before releasing any journal dependency. If a
  // later watermark update fails, the global minimum remains conservative.
  await input.incrementalProgress.put(next)

  await input.captureProgress.advance({
    streamId: input.streamId,
    generationId: input.generationId,
    entityType: 'CanonicalObservation',
    capturedRevision: cycle.throughRevision,
    ...(input.now === undefined ? {} : { now }),
  })

  const dueAt = nextDueAt(now, input.intervalMs)
  await input.cycles.completeReconciliationCycle({
    streamId: input.streamId,
    generationId: input.generationId,
    entityType: 'CanonicalObservation',
    nextDueAt: dueAt,
    ...(input.now === undefined ? {} : { now }),
  })

  return {
    kind: 'completed',
    cycle: cycle.cycle,
    throughRevision: cycle.throughRevision,
    scanned: result.scanned,
    nextDueAt: dueAt,
  }
}
