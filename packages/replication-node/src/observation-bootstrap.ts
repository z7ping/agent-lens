import type {
  HistoryBoundary,
  ReplicationPolicy,
} from '@agent-lens/core/replication'
import type { CanonicalReplicationReader } from './canonical-graph'
import {
  captureReplicationHighWater,
  pumpObservationChanges,
  type CanonicalChangeSource,
  type CanonicalObservationReader,
  type ObservationChangePumpResult,
} from './observation-change-pump'
import type { PendingCandidateSink } from './pending-sink'

export interface ObservationBootstrapProgress {
  streamId: string
  generationId: string
  phase: 'bootstrap'
  entityType: 'CanonicalObservation'
  revision: number
  throughRevision: number
  updatedAt: string
}

export interface ObservationBootstrapProgressStore {
  get(input: {
    streamId: string
    generationId: string
    phase: 'bootstrap'
    entityType: 'CanonicalObservation'
  }): Promise<ObservationBootstrapProgress | null>
  put(progress: ObservationBootstrapProgress): Promise<void>
}

export interface ObservationBootstrapPageResult extends ObservationChangePumpResult {
  initialized: boolean
}

/**
 * Bootstrap keeps one fixed high-water across retries/restarts. The high-water
 * record is durably initialized before scanning the first page; page revision
 * advances only after every entity in that page reaches Durable Pending.
 */
export async function pumpObservationBootstrapPage(input: {
  changes: CanonicalChangeSource
  observations: CanonicalObservationReader
  dependencies: CanonicalReplicationReader
  sink: PendingCandidateSink
  progress: ObservationBootstrapProgressStore
  nodeId: string
  streamId: string
  generationId: string
  policy: ReplicationPolicy
  history: HistoryBoundary
  limit?: number
  now?: string
}): Promise<ObservationBootstrapPageResult> {
  const key = {
    streamId: input.streamId,
    generationId: input.generationId,
    phase: 'bootstrap' as const,
    entityType: 'CanonicalObservation' as const,
  }
  let state = await input.progress.get(key)
  let initialized = false

  if (!state) {
    const throughRevision = await captureReplicationHighWater(input.changes)
    state = {
      ...key,
      revision: 0,
      throughRevision,
      updatedAt: input.now ?? new Date().toISOString(),
    }
    await input.progress.put(state)
    initialized = true
  }

  const result = await pumpObservationChanges({
    changes: input.changes,
    observations: input.observations,
    dependencies: input.dependencies,
    sink: input.sink,
    nodeId: input.nodeId,
    streamId: input.streamId,
    generationId: input.generationId,
    phase: 'bootstrap',
    policy: input.policy,
    history: input.history,
    throughRevision: state.throughRevision,
    afterRevision: state.revision,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  })

  await input.progress.put({
    ...state,
    revision: result.nextRevision,
    updatedAt: input.now ?? new Date().toISOString(),
  })

  return { ...result, initialized }
}
