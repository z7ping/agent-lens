import type {
  HistoryBoundary,
  ReplicationPolicy,
  ReplicationReconciliationSink,
} from '@agent-lens/core/replication'
import type { CanonicalReplicationReader } from './canonical-graph'
import {
  pumpObservationBootstrapGenerationStep,
  type ObservationBootstrapLifecycleStore,
} from './observation-bootstrap-orchestrator'
import {
  pumpObservationIncrementalPage,
  type ObservationIncrementalProgressStore,
} from './observation-incremental'
import {
  pumpObservationPeriodicReconciliationPage,
  type ObservationPeriodicReconciliationCycleStore,
  type ObservationPeriodicReconciliationResult,
} from './observation-periodic-reconciliation'
import type {
  CanonicalChangeSource,
  CanonicalObservationReader,
} from './observation-change-pump'
import type {
  CanonicalObservationSnapshotSource,
  ObservationCaptureProgressStore,
  ObservationSnapshotBootstrapProgressStore,
  ObservationSnapshotDeltaProgressStore,
} from './observation-snapshot-bootstrap'
import type { PendingCandidateSink } from './pending-sink'

export type ObservationReplicationRuntimeStepResult =
  | {
      kind: 'bootstrap'
      stage: string
      active: false
    }
  | {
      kind: 'incremental'
      throughRevision: number
      nextRevision: number
      done: false
    }
  | {
      kind: 'active'
      incrementalThroughRevision: number
      reconciliation: ObservationPeriodicReconciliationResult
    }

/**
 * One bounded Node-side replication maintenance step.
 *
 * The caller owns scheduling/backpressure. This function never loops forever:
 * it performs at most one Bootstrap page, one Incremental page, one periodic
 * Reconciliation page and one bounded journal-GC batch.
 */
export async function pumpObservationReplicationRuntimeStep(input: {
  changes: CanonicalChangeSource
  snapshot: CanonicalObservationSnapshotSource
  observations: CanonicalObservationReader
  dependencies: CanonicalReplicationReader
  pendingSink: PendingCandidateSink
  reconciliationSink: ReplicationReconciliationSink
  snapshotProgress: ObservationSnapshotBootstrapProgressStore
  deltaProgress: ObservationSnapshotDeltaProgressStore
  incrementalProgress: ObservationIncrementalProgressStore
  captureProgress: ObservationCaptureProgressStore
  lifecycle: ObservationBootstrapLifecycleStore
  cycles: ObservationPeriodicReconciliationCycleStore
  nodeId: string
  streamId: string
  generationId: string
  policy: ReplicationPolicy
  history: HistoryBoundary
  pageLimit?: number
  reconciliationIntervalMs: number
  now?: string
}): Promise<ObservationReplicationRuntimeStepResult> {
  const bootstrap = await pumpObservationBootstrapGenerationStep({
    changes: input.changes,
    snapshot: input.snapshot,
    observations: input.observations,
    dependencies: input.dependencies,
    pendingSink: input.pendingSink,
    reconciliationSink: input.reconciliationSink,
    snapshotProgress: input.snapshotProgress,
    deltaProgress: input.deltaProgress,
    captureProgress: input.captureProgress,
    lifecycle: input.lifecycle,
    nodeId: input.nodeId,
    streamId: input.streamId,
    generationId: input.generationId,
    policy: input.policy,
    history: input.history,
    ...(input.pageLimit === undefined ? {} : { limit: input.pageLimit }),
    ...(input.now === undefined ? {} : { now: input.now }),
  })
  if (!bootstrap.active) {
    return {
      kind: 'bootstrap',
      stage: bootstrap.stage,
      active: false,
    }
  }

  const bootstrapDelta = await input.deltaProgress.get({
    streamId: input.streamId,
    generationId: input.generationId,
    phase: 'bootstrap',
    entityType: 'CanonicalObservation',
  })
  if (!bootstrapDelta || bootstrapDelta.revision < bootstrapDelta.throughRevision) {
    throw new Error('Active Bootstrap lifecycle requires completed delta progress')
  }

  const incremental = await pumpObservationIncrementalPage({
    changes: input.changes,
    observations: input.observations,
    dependencies: input.dependencies,
    sink: input.pendingSink,
    progress: input.incrementalProgress,
    captureProgress: input.captureProgress,
    startRevision: bootstrapDelta.throughRevision,
    nodeId: input.nodeId,
    streamId: input.streamId,
    generationId: input.generationId,
    policy: input.policy,
    history: input.history,
    ...(input.pageLimit === undefined ? {} : { limit: input.pageLimit }),
    ...(input.now === undefined ? {} : { now: input.now }),
  })
  if (!incremental.done) {
    return {
      kind: 'incremental',
      throughRevision: incremental.throughRevision,
      nextRevision: incremental.nextRevision,
      done: false,
    }
  }

  const reconciliation = await pumpObservationPeriodicReconciliationPage({
    changes: input.changes,
    snapshot: input.snapshot,
    dependencies: input.dependencies,
    sink: input.reconciliationSink,
    cycles: input.cycles,
    captureProgress: input.captureProgress,
    incrementalProgress: input.incrementalProgress,
    nodeId: input.nodeId,
    streamId: input.streamId,
    generationId: input.generationId,
    policy: input.policy,
    history: input.history,
    intervalMs: input.reconciliationIntervalMs,
    ...(input.pageLimit === undefined ? {} : { limit: input.pageLimit }),
    ...(input.now === undefined ? {} : { now: input.now }),
  })

  return {
    kind: 'active',
    incrementalThroughRevision: incremental.throughRevision,
    reconciliation,
  }
}
