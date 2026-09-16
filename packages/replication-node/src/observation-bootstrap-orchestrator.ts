import {
  reconcileReplicationPage,
  type ReplicationReconciliationSink,
} from '@agent-lens/core/replication'
import type {
  HistoryBoundary,
  KnownReplicationEntityType,
  ReplicationPolicy,
} from '@agent-lens/core/replication'
import type { CanonicalReplicationReader } from './canonical-graph'
import type {
  CanonicalChangeSource,
  CanonicalObservationReader,
} from './observation-change-pump'
import { createObservationReconciliationSource } from './observation-reconciliation'
import {
  pumpObservationSnapshotBootstrapPage,
  pumpObservationSnapshotDeltaPage,
  type CanonicalObservationSnapshotSource,
  type ObservationCaptureProgressStore,
  type ObservationSnapshotBootstrapProgressStore,
  type ObservationSnapshotDeltaProgressStore,
} from './observation-snapshot-bootstrap'
import type { PendingCandidateSink } from './pending-sink'

export type ObservationBootstrapStage =
  | 'staged'
  | 'snapshot'
  | 'delta'
  | 'reconcile'
  | 'active'

export interface ObservationBootstrapLifecycleState {
  streamId: string
  generationId: string
  entityType: KnownReplicationEntityType
  stage: ObservationBootstrapStage
  policyRevision: string
  historyRevision: string
  updatedAt: string
}

export interface ObservationBootstrapLifecycleStore {
  ensure(input: {
    streamId: string
    generationId: string
    entityType: 'CanonicalObservation'
    policyRevision: string
    historyRevision: string
    now?: string
  }): Promise<ObservationBootstrapLifecycleState>
  transition(input: {
    streamId: string
    generationId: string
    entityType: 'CanonicalObservation'
    stage: ObservationBootstrapStage
    policyRevision: string
    historyRevision: string
    now?: string
  }): Promise<ObservationBootstrapLifecycleState>
}

export interface ObservationBootstrapGenerationStepResult {
  stage: ObservationBootstrapStage
  active: boolean
  work:
    | { kind: 'none' }
    | { kind: 'snapshot'; done: boolean; scanned: number }
    | { kind: 'delta'; done: boolean; changes: number; throughRevision: number }
    | { kind: 'reconcile'; done: boolean; scanned: number }
}

/**
 * Run one bounded Bootstrap Generation step.
 *
 * Lifecycle is durable and monotonic:
 * staged -> snapshot -> delta -> reconcile -> active.
 *
 * The stream becomes active only after a full current-state reconciliation
 * pass has completed. Writes committed during reconciliation remain covered by
 * the incremental journal because activation starts after the fixed bootstrap
 * delta watermark rather than treating reconciliation itself as a journal ACK.
 */
export async function pumpObservationBootstrapGenerationStep(input: {
  changes: CanonicalChangeSource
  snapshot: CanonicalObservationSnapshotSource
  observations: CanonicalObservationReader
  dependencies: CanonicalReplicationReader
  pendingSink: PendingCandidateSink
  reconciliationSink: ReplicationReconciliationSink
  snapshotProgress: ObservationSnapshotBootstrapProgressStore
  deltaProgress: ObservationSnapshotDeltaProgressStore
  captureProgress: ObservationCaptureProgressStore
  lifecycle: ObservationBootstrapLifecycleStore
  nodeId: string
  streamId: string
  generationId: string
  policy: ReplicationPolicy
  history: HistoryBoundary
  limit?: number
  now?: string
}): Promise<ObservationBootstrapGenerationStepResult> {
  const key = {
    streamId: input.streamId,
    generationId: input.generationId,
    entityType: 'CanonicalObservation' as const,
    policyRevision: input.policy.revision,
    historyRevision: input.history.revision,
    ...(input.now === undefined ? {} : { now: input.now }),
  }
  let lifecycle = await input.lifecycle.ensure(key)

  if (lifecycle.stage === 'staged') {
    lifecycle = await input.lifecycle.transition({ ...key, stage: 'snapshot' })
  }

  if (lifecycle.stage === 'snapshot') {
    const result = await pumpObservationSnapshotBootstrapPage({
      changes: input.changes,
      snapshot: input.snapshot,
      dependencies: input.dependencies,
      sink: input.pendingSink,
      progress: input.snapshotProgress,
      captureProgress: input.captureProgress,
      nodeId: input.nodeId,
      streamId: input.streamId,
      generationId: input.generationId,
      policy: input.policy,
      history: input.history,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.now === undefined ? {} : { now: input.now }),
    })
    if (result.done) {
      lifecycle = await input.lifecycle.transition({ ...key, stage: 'delta' })
    }
    return {
      stage: lifecycle.stage,
      active: false,
      work: { kind: 'snapshot', done: result.done, scanned: result.observationCount },
    }
  }

  if (lifecycle.stage === 'delta') {
    const result = await pumpObservationSnapshotDeltaPage({
      changes: input.changes,
      observations: input.observations,
      dependencies: input.dependencies,
      sink: input.pendingSink,
      snapshotProgress: input.snapshotProgress,
      deltaProgress: input.deltaProgress,
      captureProgress: input.captureProgress,
      nodeId: input.nodeId,
      streamId: input.streamId,
      generationId: input.generationId,
      policy: input.policy,
      history: input.history,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.now === undefined ? {} : { now: input.now }),
    })
    if (result.done) {
      lifecycle = await input.lifecycle.transition({ ...key, stage: 'reconcile' })
    }
    return {
      stage: lifecycle.stage,
      active: false,
      work: {
        kind: 'delta',
        done: result.done,
        changes: result.changeCount,
        throughRevision: result.throughRevision,
      },
    }
  }

  if (lifecycle.stage === 'reconcile') {
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
      sink: input.reconciliationSink,
      streamId: input.streamId,
      generationId: input.generationId,
      entityType: 'CanonicalObservation',
      policyRevision: input.policy.revision,
      historyRevision: input.history.revision,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    })
    if (result.done) {
      lifecycle = await input.lifecycle.transition({ ...key, stage: 'active' })
    }
    return {
      stage: lifecycle.stage,
      active: lifecycle.stage === 'active',
      work: { kind: 'reconcile', done: result.done, scanned: result.scanned },
    }
  }

  return {
    stage: 'active',
    active: true,
    work: { kind: 'none' },
  }
}
