import type { JsonValue } from '../domain/common'
import type { KnownReplicationEntityType } from './types'
import type { ReplicationHistoryPhase } from './history'

export interface ReplicationReconciliationCandidate {
  id: string
  dedupKey: string
  entityType: KnownReplicationEntityType
  originEntityId: string
  candidateHash: string
  payload: JsonValue
}

export interface ReplicationReconciliationPage {
  items: readonly ReplicationReconciliationCandidate[]
  nextCursor: string
  done: boolean
}

export interface ReplicationReconciliationSource {
  scan(input: {
    entityType: KnownReplicationEntityType
    cursor?: string
    limit: number
  }): Promise<ReplicationReconciliationPage>
}

export interface ReplicationReconciliationSink {
  enqueue(input: {
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
  }): Promise<{ created: boolean; replaced: boolean }>
  getCursor(streamId: string, entityType: KnownReplicationEntityType): Promise<string | undefined>
  setCursor(streamId: string, entityType: KnownReplicationEntityType, cursor: string): Promise<void>
}

export interface ReplicationReconciliationResult {
  scanned: number
  created: number
  replaced: number
  unchanged: number
  nextCursor: string
  done: boolean
}

export async function reconcileReplicationPage(input: {
  source: ReplicationReconciliationSource
  sink: ReplicationReconciliationSink
  streamId: string
  generationId: string
  entityType: KnownReplicationEntityType
  policyRevision: string
  historyRevision: string
  limit?: number
}): Promise<ReplicationReconciliationResult> {
  const cursor = await input.sink.getCursor(input.streamId, input.entityType)
  const page = await input.source.scan({
    entityType: input.entityType,
    ...(cursor === undefined ? {} : { cursor }),
    limit: input.limit ?? 100,
  })

  let created = 0
  let replaced = 0
  let unchanged = 0
  for (const candidate of page.items) {
    const result = await input.sink.enqueue({
      id: candidate.id,
      streamId: input.streamId,
      generationId: input.generationId,
      dedupKey: candidate.dedupKey,
      entityType: candidate.entityType,
      originEntityId: candidate.originEntityId,
      candidateHash: candidate.candidateHash,
      phase: 'reconcile',
      policyRevision: input.policyRevision,
      historyRevision: input.historyRevision,
      payload: candidate.payload,
    })
    if (result.created) created += 1
    else if (result.replaced) replaced += 1
    else unchanged += 1
  }

  await input.sink.setCursor(input.streamId, input.entityType, page.nextCursor)
  return {
    scanned: page.items.length,
    created,
    replaced,
    unchanged,
    nextCursor: page.nextCursor,
    done: page.done,
  }
}
