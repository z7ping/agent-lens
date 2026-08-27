import type { JsonValue as CoreJsonValue } from '@agent-lens/core'
import type {
  KnownReplicationEntityType,
  ReplicationHistoryPhase,
} from '@agent-lens/core/replication'
import {
  canonicalHash,
  type WireEntityEnvelope,
} from '@agent-lens/protocol/replication'

export interface PendingWireCandidate {
  id: string
  streamId: string
  generationId: string
  dedupKey: string
  entityType: KnownReplicationEntityType
  originEntityId: string
  candidateHash: string
  phase: ReplicationHistoryPhase
  policyRevision: string
  historyRevision: string
  payload: CoreJsonValue
}

function identityDigest(entityType: string, originEntityId: string): string {
  return canonicalHash([entityType, originEntityId])
}

export function pendingCandidateForWireEntity(input: {
  streamId: string
  generationId: string
  phase: ReplicationHistoryPhase
  policyRevision: string
  historyRevision: string
  entity: WireEntityEnvelope
}): PendingWireCandidate {
  const identityHash = identityDigest(input.entity.entityType, input.entity.originEntityId)
  const dedupKey = `entity-r1-${identityHash}`
  const id = `pending-r1-${canonicalHash([
    input.streamId,
    input.generationId,
    dedupKey,
    input.entity.contentHash,
  ])}`

  return {
    id,
    streamId: input.streamId,
    generationId: input.generationId,
    dedupKey,
    entityType: input.entity.entityType as KnownReplicationEntityType,
    originEntityId: input.entity.originEntityId,
    candidateHash: input.entity.contentHash,
    phase: input.phase,
    policyRevision: input.policyRevision,
    historyRevision: input.historyRevision,
    payload: input.entity as unknown as CoreJsonValue,
  }
}

export function pendingCandidatesForWireGraph(input: {
  streamId: string
  generationId: string
  phase: ReplicationHistoryPhase
  policyRevision: string
  historyRevision: string
  entities: readonly WireEntityEnvelope[]
}): readonly PendingWireCandidate[] {
  return input.entities.map(entity => pendingCandidateForWireEntity({
    streamId: input.streamId,
    generationId: input.generationId,
    phase: input.phase,
    policyRevision: input.policyRevision,
    historyRevision: input.historyRevision,
    entity,
  }))
}
