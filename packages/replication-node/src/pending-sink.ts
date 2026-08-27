import type { WireEntityEnvelope } from '@agent-lens/protocol/replication'
import {
  pendingCandidatesForWireGraph,
  type PendingWireCandidate,
} from './pending-candidate'

export interface PendingCandidateSinkResult {
  created: boolean
  replaced: boolean
}

/**
 * Structural boundary implemented by H5 durable repositories.
 * The Node replication application layer does not depend on SQLite.
 */
export interface PendingCandidateSink {
  enqueuePending(input: PendingWireCandidate): Promise<PendingCandidateSinkResult>
}

export interface EnqueueWireGraphResult {
  total: number
  created: number
  replaced: number
  unchanged: number
}

/**
 * Enqueue dependency-first wire entities sequentially. A mid-run failure may leave
 * an already-enqueued prefix; H5 dedup/candidateHash semantics make retry safe.
 */
export async function enqueueWireGraph(input: {
  sink: PendingCandidateSink
  streamId: string
  generationId: string
  phase: PendingWireCandidate['phase']
  policyRevision: string
  historyRevision: string
  entities: readonly WireEntityEnvelope[]
}): Promise<EnqueueWireGraphResult> {
  const candidates = pendingCandidatesForWireGraph({
    streamId: input.streamId,
    generationId: input.generationId,
    phase: input.phase,
    policyRevision: input.policyRevision,
    historyRevision: input.historyRevision,
    entities: input.entities,
  })

  let created = 0
  let replaced = 0
  let unchanged = 0
  for (const candidate of candidates) {
    const result = await input.sink.enqueuePending(candidate)
    if (result.created) created += 1
    else if (result.replaced) replaced += 1
    else unchanged += 1
  }

  return {
    total: candidates.length,
    created,
    replaced,
    unchanged,
  }
}
