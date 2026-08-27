import type { JsonValue as CoreJsonValue } from '@agent-lens/core'
import {
  sharedRootKeyFor,
  type FrozenReplicationBatch,
  type PendingReplicationEntity,
  type ReplicationStreamState,
} from '@agent-lens/core/replication'
import {
  REPLICATION_PROTOCOL,
  assertEntityEnvelope,
  assertReplicationBatch,
  canonicalHash,
  computeBatchContentHash,
  type ReplicationBatch,
  type SharedIdentityAssertion,
  type WireEntityEnvelope,
  type WireEntityRef,
} from '@agent-lens/protocol/replication'

export interface BatchFreezeStore {
  getStream(streamId: string): Promise<ReplicationStreamState | undefined>
  listPending(streamId: string, limit?: number): Promise<readonly PendingReplicationEntity[]>
  freezeBatch(input: {
    streamId: string
    generationId: string
    sequence: number
    batchId: string
    contentHash: string
    phase: PendingReplicationEntity['phase']
    policyRevision: string
    historyRevision: string
    payload: CoreJsonValue
    pendingItemIds: readonly string[]
  }): Promise<FrozenReplicationBatch>
}

export interface BuiltReplicationBatch {
  batch: ReplicationBatch
  pendingItemIds: readonly string[]
}

function entityFromPending(item: PendingReplicationEntity): WireEntityEnvelope {
  if (!item.payload || typeof item.payload !== 'object' || Array.isArray(item.payload)) {
    throw new Error(`Pending replication payload is not a WireEntityEnvelope: ${item.id}`)
  }
  const entity = item.payload as unknown as WireEntityEnvelope
  assertEntityEnvelope(entity)
  if (entity.entityType !== item.entityType || entity.originEntityId !== item.originEntityId) {
    throw new Error(`Pending replication identity mismatch: ${item.id}`)
  }
  if (entity.contentHash !== item.candidateHash) {
    throw new Error(`Pending replication candidate hash mismatch: ${item.id}`)
  }
  return entity
}

function nodeKey(entityType: string, originEntityId: string): string {
  return `node:${entityType}\u0000${originEntityId}`
}

function sharedKey(entity: WireEntityEnvelope): string | undefined {
  if (entity.entityType !== 'AgentProduct' || entity.scope !== 'shared') return undefined
  return `shared:AgentProduct\u0000${sharedRootKeyFor('AgentProduct', entity.originEntityId)}`
}

function refKey(ref: WireEntityRef): string {
  return ref.kind === 'node'
    ? nodeKey(ref.entityType, ref.originEntityId)
    : `shared:${ref.entityType}\u0000${ref.sharedKey}`
}

function allRefs(entity: WireEntityEnvelope): WireEntityRef[] {
  const refs: WireEntityRef[] = []
  for (const value of Object.values(entity.references ?? {})) {
    if (Array.isArray(value)) refs.push(...value)
    else refs.push(value as WireEntityRef)
  }
  return refs
}

function topologicallySort(items: readonly PendingReplicationEntity[]): Array<{
  item: PendingReplicationEntity
  entity: WireEntityEnvelope
}> {
  const nodes = items.map(item => ({ item, entity: entityFromPending(item) }))
  const byRef = new Map<string, number>()

  nodes.forEach((node, index) => {
    byRef.set(nodeKey(node.entity.entityType, node.entity.originEntityId), index)
    const shared = sharedKey(node.entity)
    if (shared) byRef.set(shared, index)
  })

  const outgoing = nodes.map(() => new Set<number>())
  const indegree = nodes.map(() => 0)

  nodes.forEach((node, dependentIndex) => {
    const dependencies = new Set<number>()
    for (const ref of allRefs(node.entity)) {
      const dependencyIndex = byRef.get(refKey(ref))
      if (dependencyIndex === undefined || dependencyIndex === dependentIndex) continue
      dependencies.add(dependencyIndex)
    }
    for (const dependencyIndex of dependencies) {
      outgoing[dependencyIndex]!.add(dependentIndex)
      indegree[dependentIndex] = (indegree[dependentIndex] ?? 0) + 1
    }
  })

  const stableNodeKey = (index: number): string => {
    const node = nodes[index]!
    return `${node.entity.entityType}\u0000${node.entity.originEntityId}\u0000${node.entity.contentHash}`
  }
  const ready = indegree
    .map((degree, index) => ({ degree, index }))
    .filter(entry => entry.degree === 0)
    .map(entry => entry.index)
    .sort((a, b) => stableNodeKey(a).localeCompare(stableNodeKey(b)))

  const ordered: typeof nodes = []
  while (ready.length > 0) {
    const index = ready.shift()!
    ordered.push(nodes[index]!)
    for (const dependent of outgoing[index]!) {
      indegree[dependent]!--
      if (indegree[dependent] === 0) {
        ready.push(dependent)
        ready.sort((a, b) => stableNodeKey(a).localeCompare(stableNodeKey(b)))
      }
    }
  }

  if (ordered.length !== nodes.length) {
    throw new Error('Replication pending dependency cycle prevents batch freeze')
  }
  return ordered
}

function phaseRank(phase: PendingReplicationEntity['phase']): number {
  if (phase === 'bootstrap') return 0
  if (phase === 'reconcile') return 1
  return 2
}

function selectCompatiblePending(items: readonly PendingReplicationEntity[]): readonly PendingReplicationEntity[] {
  if (items.length === 0) return []
  const groups = new Map<string, PendingReplicationEntity[]>()
  for (const item of items) {
    const key = `${phaseRank(item.phase)}\u0000${item.phase}\u0000${item.policyRevision}\u0000${item.historyRevision}\u0000${item.generationId}`
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }
  const key = [...groups.keys()].sort()[0]!
  return groups.get(key)!
}

function identityPromotions(entities: readonly WireEntityEnvelope[]): readonly SharedIdentityAssertion[] {
  const values = new Map<string, SharedIdentityAssertion>()
  for (const entity of entities) {
    if (!entity.sharedIdentity) continue
    const assertion = entity.sharedIdentity
    const key = `${assertion.identityAlgorithm}\u0000${assertion.claimedSharedKey}`
    values.set(key, assertion)
  }
  return [...values.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value)
}

export function buildReplicationBatch(input: {
  nodeId: string
  hubId: string
  stream: ReplicationStreamState
  pending: readonly PendingReplicationEntity[]
  entityLimit?: number
}): BuiltReplicationBatch | null {
  const compatible = selectCompatiblePending(input.pending)
  if (compatible.length === 0) return null
  if (compatible.some(item => item.streamId !== input.stream.streamId || item.generationId !== input.stream.generationId)) {
    throw new Error('Pending replication item does not belong to active stream generation')
  }

  const ordered = topologicallySort(compatible)
  const limit = Math.max(1, Math.min(input.entityLimit ?? 200, 1000))
  const selected = ordered.slice(0, limit)
  const entities = selected.map(node => node.entity)
  const first = selected[0]!.item

  const batchId = `batch-r1-${canonicalHash([
    input.stream.streamId,
    input.stream.generationId,
    input.stream.nextSequence,
    first.phase,
    first.policyRevision,
    first.historyRevision,
    entities.map(entity => entity.contentHash),
  ])}`

  const base: Omit<ReplicationBatch, 'contentHash'> = {
    protocol: REPLICATION_PROTOCOL,
    nodeId: input.nodeId,
    hubId: input.hubId,
    streamId: input.stream.streamId,
    generationId: input.stream.generationId,
    sequence: input.stream.nextSequence,
    batchId,
    phase: first.phase,
    policyRevision: first.policyRevision,
    historyRevision: first.historyRevision,
    entities,
    identityPromotions: identityPromotions(entities),
  }
  const batch: ReplicationBatch = {
    ...base,
    contentHash: computeBatchContentHash(base),
  }
  assertReplicationBatch(batch)

  return {
    batch,
    pendingItemIds: selected.map(node => node.item.id),
  }
}

export async function freezeNextReplicationBatch(input: {
  store: BatchFreezeStore
  nodeId: string
  hubId: string
  streamId: string
  scanLimit?: number
  entityLimit?: number
}): Promise<FrozenReplicationBatch | null> {
  const stream = await input.store.getStream(input.streamId)
  if (!stream) throw new Error(`Unknown replication stream: ${input.streamId}`)
  const pending = await input.store.listPending(input.streamId, input.scanLimit ?? 1000)
  const built = buildReplicationBatch({
    nodeId: input.nodeId,
    hubId: input.hubId,
    stream,
    pending,
    ...(input.entityLimit === undefined ? {} : { entityLimit: input.entityLimit }),
  })
  if (!built) return null

  return input.store.freezeBatch({
    streamId: built.batch.streamId,
    generationId: built.batch.generationId,
    sequence: built.batch.sequence,
    batchId: built.batch.batchId,
    contentHash: built.batch.contentHash,
    phase: built.batch.phase,
    policyRevision: built.batch.policyRevision,
    historyRevision: built.batch.historyRevision,
    payload: built.batch as unknown as CoreJsonValue,
    pendingItemIds: built.pendingItemIds,
  })
}
