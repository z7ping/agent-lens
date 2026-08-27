import type { CanonicalObservation } from '@agent-lens/core'
import type {
  HistoryBoundary,
  KnownReplicationEntityType,
  ReplicationHistoryPhase,
  ReplicationPolicy,
} from '@agent-lens/core/replication'
import {
  generateObservationReplicaGraph,
  type CanonicalReplicationReader,
} from './canonical-graph'
import {
  enqueueWireGraph,
  type PendingCandidateSink,
} from './pending-sink'

export interface CanonicalChangeEntry {
  revision: number
  entityType: KnownReplicationEntityType
  originEntityId: string
  changedAt: string
}

export interface CanonicalChangePage {
  items: readonly CanonicalChangeEntry[]
  nextRevision: number
  done: boolean
}

export interface CanonicalChangeSource {
  highWaterRevision(): Promise<number>
  scan(input: {
    afterRevision?: number
    throughRevision: number
    entityType?: KnownReplicationEntityType
    limit?: number
  }): Promise<CanonicalChangePage>
}

export interface CanonicalObservationReader {
  get(id: string): Promise<CanonicalObservation | null>
}

export interface ObservationChangePumpResult {
  throughRevision: number
  nextRevision: number
  done: boolean
  changeCount: number
  observationCount: number
  blockedCount: number
  pending: {
    total: number
    created: number
    replaced: number
    unchanged: number
  }
}

export async function captureReplicationHighWater(source: CanonicalChangeSource): Promise<number> {
  return source.highWaterRevision()
}

/**
 * Process one bounded page of CanonicalObservation changes. The caller captures
 * throughRevision once for bootstrap; incremental runs can capture a newer high
 * water and continue from the previous revision. Event time is never used as a
 * replication watermark.
 */
export async function pumpObservationChanges(input: {
  changes: CanonicalChangeSource
  observations: CanonicalObservationReader
  dependencies: CanonicalReplicationReader
  sink: PendingCandidateSink
  nodeId: string
  streamId: string
  generationId: string
  phase: Extract<ReplicationHistoryPhase, 'bootstrap' | 'incremental' | 'reconcile'>
  policy: ReplicationPolicy
  history: HistoryBoundary
  throughRevision: number
  afterRevision?: number
  limit?: number
}): Promise<ObservationChangePumpResult> {
  const page = await input.changes.scan({
    ...(input.afterRevision === undefined ? {} : { afterRevision: input.afterRevision }),
    throughRevision: input.throughRevision,
    entityType: 'CanonicalObservation',
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  })

  const seen = new Set<string>()
  let observationCount = 0
  let blockedCount = 0
  let pendingTotal = 0
  let created = 0
  let replaced = 0
  let unchanged = 0

  for (const change of page.items) {
    if (seen.has(change.originEntityId)) continue
    seen.add(change.originEntityId)

    const observation = await input.observations.get(change.originEntityId)
    if (!observation) {
      throw new Error(
        `Replication Canonical row missing without tombstone: CanonicalObservation:${change.originEntityId}`,
      )
    }
    observationCount += 1

    const graph = await generateObservationReplicaGraph({
      nodeId: input.nodeId,
      reader: input.dependencies,
      observation,
      phase: input.phase,
      policy: input.policy,
      history: input.history,
    })
    if (graph.kind === 'blocked') {
      blockedCount += 1
      continue
    }

    const result = await enqueueWireGraph({
      sink: input.sink,
      streamId: input.streamId,
      generationId: input.generationId,
      phase: input.phase,
      policyRevision: input.policy.revision,
      historyRevision: input.history.revision,
      entities: graph.entities,
    })
    pendingTotal += result.total
    created += result.created
    replaced += result.replaced
    unchanged += result.unchanged
  }

  return {
    throughRevision: input.throughRevision,
    nextRevision: page.nextRevision,
    done: page.done,
    changeCount: page.items.length,
    observationCount,
    blockedCount,
    pending: {
      total: pendingTotal,
      created,
      replaced,
      unchanged,
    },
  }
}
