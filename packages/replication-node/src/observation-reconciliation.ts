import type {
  ReplicationReconciliationCandidate,
  ReplicationReconciliationSource,
  HistoryBoundary,
  ReplicationPolicy,
} from '@agent-lens/core/replication'
import {
  generateObservationReplicaGraph,
  type CanonicalReplicationReader,
} from './canonical-graph'
import { pendingCandidatesForWireGraph } from './pending-candidate'
import type { CanonicalObservationSnapshotSource } from './observation-snapshot-bootstrap'

function fromNowBoundary(history: HistoryBoundary): string | undefined {
  if (history.mode !== 'from-now') return undefined
  if (!history.boundaryCapturedAt || !Number.isFinite(Date.parse(history.boundaryCapturedAt))) {
    throw new Error('from-now Reconciliation requires a valid boundaryCapturedAt')
  }
  return history.boundaryCapturedAt
}

/**
 * Adapt current CanonicalObservation root state to the generic Core
 * ReconciliationSource contract. Cursor is the immutable Observation id.
 *
 * The page limit bounds root observations, not flattened dependency candidates.
 * The generated graph remains dependency-first and Pending dedup collapses
 * shared dependencies across roots.
 */
export function createObservationReconciliationSource(input: {
  snapshot: CanonicalObservationSnapshotSource
  dependencies: CanonicalReplicationReader
  nodeId: string
  streamId: string
  generationId: string
  policy: ReplicationPolicy
  history: HistoryBoundary
}): ReplicationReconciliationSource {
  const boundary = fromNowBoundary(input.history)

  return {
    async scan({ entityType, cursor, limit }) {
      if (entityType !== 'CanonicalObservation') {
        throw new Error(
          'Observation reconciliation source does not support entity type: ' + entityType,
        )
      }

      const page = await input.snapshot.scan({
        ...(cursor ? { afterId: cursor } : {}),
        ...(boundary === undefined ? {} : { capturedAtOnOrAfter: boundary }),
        limit,
      })

      const candidatesByDedupKey = new Map<string, ReplicationReconciliationCandidate>()
      for (const observation of page.items) {
        const graph = await generateObservationReplicaGraph({
          nodeId: input.nodeId,
          reader: input.dependencies,
          observation,
          phase: 'reconcile',
          policy: input.policy,
          history: input.history,
        })
        if (graph.kind === 'blocked') continue

        for (const candidate of pendingCandidatesForWireGraph({
          streamId: input.streamId,
          generationId: input.generationId,
          phase: 'reconcile',
          policyRevision: input.policy.revision,
          historyRevision: input.history.revision,
          entities: graph.entities,
        })) {
          candidatesByDedupKey.set(candidate.dedupKey, {
            id: candidate.id,
            dedupKey: candidate.dedupKey,
            entityType: candidate.entityType,
            originEntityId: candidate.originEntityId,
            candidateHash: candidate.candidateHash,
            payload: candidate.payload,
          })
        }
      }

      return {
        items: [...candidatesByDedupKey.values()],
        nextCursor: page.nextCursor ?? cursor ?? '',
        done: page.done,
      }
    },
  }
}
