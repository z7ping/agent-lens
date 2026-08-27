import type { JsonValue } from '../domain/common'
import type { KnownReplicationEntityType } from './types'
import type { ReplicationHistoryPhase } from './history'

export type ReplicationStreamStatus = 'active' | 'paused' | 'rollover-required'
export type ReplicationBatchStatus = 'frozen' | 'acked'

export interface ReplicationStreamState {
  relationshipId: string
  hubId: string
  streamId: string
  generationId: string
  status: ReplicationStreamStatus
  nextSequence: number
  ackSequence: number
  policyRevision: string
  historyRevision: string
  createdAt: string
  updatedAt: string
}

export interface PendingReplicationEntity {
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
  payload: JsonValue
  createdAt: string
  updatedAt: string
  frozenSequence?: number
}

export interface FrozenReplicationBatch {
  streamId: string
  generationId: string
  sequence: number
  batchId: string
  contentHash: string
  phase: ReplicationHistoryPhase
  policyRevision: string
  historyRevision: string
  payload: JsonValue
  status: ReplicationBatchStatus
  frozenAt: string
  ackedAt?: string
  pendingItemIds: readonly string[]
}

export interface ReplicationReconciliationCursor {
  streamId: string
  entityType: KnownReplicationEntityType
  cursor: string
  updatedAt: string
}

export class DurableReplicationError extends Error {
  readonly code:
    | 'STREAM_INVALID'
    | 'SEQUENCE_GAP'
    | 'SEQUENCE_REUSE_CONFLICT'
    | 'BATCH_IMMUTABLE'
    | 'PENDING_ITEM_INVALID'

  constructor(code: DurableReplicationError['code'], message: string) {
    super(message)
    this.name = 'DurableReplicationError'
    this.code = code
  }
}

export function assertReplicationStreamState(state: ReplicationStreamState): void {
  if (!state.streamId || !state.relationshipId || !state.hubId || !state.generationId) {
    throw new DurableReplicationError('STREAM_INVALID', 'Replication stream identity is incomplete')
  }
  if (!Number.isInteger(state.nextSequence) || state.nextSequence < 1) {
    throw new DurableReplicationError('STREAM_INVALID', 'nextSequence must be a positive integer')
  }
  if (!Number.isInteger(state.ackSequence) || state.ackSequence < 0) {
    throw new DurableReplicationError('STREAM_INVALID', 'ackSequence must be a non-negative integer')
  }
  if (state.nextSequence <= state.ackSequence) {
    throw new DurableReplicationError('STREAM_INVALID', 'nextSequence must be greater than ackSequence')
  }
}

export function assertFreezeSequence(input: {
  stream: ReplicationStreamState
  incomingSequence: number
  incomingBatchId: string
  existingBatch?: Pick<FrozenReplicationBatch, 'sequence' | 'batchId' | 'contentHash'>
  incomingContentHash: string
}): 'freeze' | 'exact-retry' {
  if (!input.incomingBatchId) {
    throw new DurableReplicationError('BATCH_IMMUTABLE', 'Frozen batch requires a stable batchId')
  }
  if (input.existingBatch) {
    if (input.existingBatch.sequence !== input.incomingSequence) {
      throw new DurableReplicationError('SEQUENCE_REUSE_CONFLICT', 'Existing batch sequence does not match retry')
    }
    if (
      input.existingBatch.batchId !== input.incomingBatchId
      || input.existingBatch.contentHash !== input.incomingContentHash
    ) {
      throw new DurableReplicationError(
        'SEQUENCE_REUSE_CONFLICT',
        'Frozen sequence cannot be reused with a different batchId or content hash',
      )
    }
    return 'exact-retry'
  }
  if (input.incomingSequence !== input.stream.nextSequence) {
    throw new DurableReplicationError('SEQUENCE_GAP', `Expected sequence ${input.stream.nextSequence}, got ${input.incomingSequence}`)
  }
  return 'freeze'
}

export function assertAckAdvance(input: {
  stream: ReplicationStreamState
  sequence: number
}): 'advance' | 'already-acked' {
  if (input.sequence <= input.stream.ackSequence) return 'already-acked'
  if (input.sequence !== input.stream.ackSequence + 1) {
    throw new DurableReplicationError('SEQUENCE_GAP', `ACK must advance from ${input.stream.ackSequence} to ${input.stream.ackSequence + 1}`)
  }
  return 'advance'
}
