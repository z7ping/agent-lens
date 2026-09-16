import type {
  HistoryBoundary,
  ReplicationPolicy,
} from '@agent-lens/core/replication'
import type { CanonicalReplicationReader } from './canonical-graph'
import {
  pumpObservationChanges,
  type CanonicalChangeSource,
  type CanonicalObservationReader,
  type ObservationChangePumpResult,
} from './observation-change-pump'
import type { ObservationCaptureProgressStore } from './observation-snapshot-bootstrap'
import type { PendingCandidateSink } from './pending-sink'

export interface ObservationIncrementalProgress {
  streamId: string
  generationId: string
  phase: 'incremental'
  entityType: 'CanonicalObservation'
  revision: number
  throughRevision: number
  updatedAt: string
}

export interface ObservationIncrementalProgressStore {
  get(input: {
    streamId: string
    generationId: string
    phase: 'incremental'
    entityType: 'CanonicalObservation'
  }): Promise<ObservationIncrementalProgress | null>
  put(progress: ObservationIncrementalProgress): Promise<void>
}

export interface ObservationIncrementalPageResult extends ObservationChangePumpResult {
  initialized: boolean
}

/**
 * Process one bounded incremental journal page. capturedRevision only advances
 * after every entity on the page has reached Durable Pending.
 */
export async function pumpObservationIncrementalPage(input: {
  changes: CanonicalChangeSource
  observations: CanonicalObservationReader
  dependencies: CanonicalReplicationReader
  sink: PendingCandidateSink
  progress: ObservationIncrementalProgressStore
  captureProgress: ObservationCaptureProgressStore
  startRevision: number
  nodeId: string
  streamId: string
  generationId: string
  policy: ReplicationPolicy
  history: HistoryBoundary
  limit?: number
  now?: string
}): Promise<ObservationIncrementalPageResult> {
  if (!Number.isInteger(input.startRevision) || input.startRevision < 0) {
    throw new TypeError('Incremental startRevision must be a non-negative integer')
  }
  const key = {
    streamId: input.streamId,
    generationId: input.generationId,
    phase: 'incremental' as const,
    entityType: 'CanonicalObservation' as const,
  }
  const now = input.now ?? new Date().toISOString()
  let state = await input.progress.get(key)
  let initialized = false

  if (!state) {
    state = {
      ...key,
      revision: input.startRevision,
      throughRevision: input.startRevision,
      updatedAt: now,
    }
    await input.progress.put(state)
    await input.captureProgress.advance({
      streamId: input.streamId,
      generationId: input.generationId,
      entityType: 'CanonicalObservation',
      capturedRevision: input.startRevision,
      ...(input.now === undefined ? {} : { now: input.now }),
    })
    initialized = true
  } else if (state.revision < input.startRevision) {
    throw new Error('Incremental progress precedes Bootstrap activation watermark')
  }

  if (state.revision === state.throughRevision) {
    const highWater = await input.changes.highWaterRevision()
    if (highWater < state.revision) {
      throw new Error('Replication journal high-water moved behind incremental progress')
    }
    if (highWater > state.throughRevision) {
      state = { ...state, throughRevision: highWater, updatedAt: now }
      await input.progress.put(state)
    }
  }

  const result = await pumpObservationChanges({
    changes: input.changes,
    observations: input.observations,
    dependencies: input.dependencies,
    sink: input.sink,
    nodeId: input.nodeId,
    streamId: input.streamId,
    generationId: input.generationId,
    phase: 'incremental',
    policy: input.policy,
    history: input.history,
    throughRevision: state.throughRevision,
    afterRevision: state.revision,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  })

  const nextRevision = result.done ? state.throughRevision : result.nextRevision
  await input.progress.put({ ...state, revision: nextRevision, updatedAt: now })
  await input.captureProgress.advance({
    streamId: input.streamId,
    generationId: input.generationId,
    entityType: 'CanonicalObservation',
    capturedRevision: nextRevision,
    ...(input.now === undefined ? {} : { now: input.now }),
  })

  return { ...result, nextRevision, initialized }
}
