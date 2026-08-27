import type { JsonValue as CoreJsonValue } from '@agent-lens/core'
import {
  sharedRootKeyFor,
  type FrozenReplicationBatch,
  type KnownReplicationEntityType,
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

export interface PendingDependencyLookup {
  findOpen(input: {
    streamId: string
    generationId: string
    entityType: KnownReplicationEntityType
    originEntityId: string
  }): Promise<PendingReplicationEntity | undefined>
  findOpenAgentProductSharedRoot(input: {
    streamId: string
    generationId: string
    sharedKey: string
  }): Promise<PendingReplicationEntity | undefined>
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
      indegree[dependent] = (indegree[dependent] ?? 0) - 1
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

function batchGroupKey(item: PendingReplicationEntity): string {
  return `${phaseRank(item.phase)}\u0000${item.phase}\u0000${item.policyRevision}\u0000${item.historyRevision}\u0000${item.generationId}`
}

function selectCompatiblePending(items: readonly PendingReplicationEntity[]): readonly PendingReplicationEntity[] {
  if (items.length === 0) return []
  const groups = new Map<string, PendingReplicationEntity[]>()
  for (const item of items) {
    const key = batchGroupKey(item)
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }
  const key = [...groups.keys()].sort()[0]!
  return groups.get(key)!
}

async function expandPendingDependencyClosure(input: {
  seed: readonly PendingReplicationEntity[]
  lookup: PendingDependencyLookup
  streamId: string
  generationId: string
  maxItems?: number
}): Promise<readonly PendingReplicationEntity[]> {
  if (input.seed.length === 0) return []
  const groupKey = batchGroupKey(input.seed[0]!)
  const maxItems = Math.max(input.seed.length, Math.min(input.maxItems ?? 5000, 10000))
  const items = new Map(input.seed.map(item => [item.id, item]))
  const queue = [...input.seed]

  while (queue.length > 0) {
    const current = queue.shift()!
    const entity = entityFromPending(current)
    for (const ref of allRefs(entity)) {
      let dependency: PendingReplicationEntity | undefined
      if (ref.kind === 'node') {
        dependency = await input.lookup.findOpen({
          streamId: input.streamId,
          generationId: input.generationId,
          entityType: ref.entityType as KnownReplicationEntityType,
          originEntityId: ref.originEntityId,
        })
      } else if (ref.entityType === 'AgentProduct') {
        dependency = await input.lookup.findOpenAgentProductSharedRoot({
          streamId: input.streamId,
          generationId: input.generationId,
          sharedKey: ref.sharedKey,
        })
      }

      if (!dependency || items.has(dependency.id)) continue
      if (batchGroupKey(dependency) !== groupKey) {
        throw new Error(
          `Open dependency ${dependency.entityType}:${dependency.originEntityId} belongs to a different replication batch group`,
        )
      }
      items.set(dependency.id, dependency)
      queue.push(dependency)
      if (items.size > maxItems) {
        throw new Error(`Replication Pending dependency closure exceeds ${maxItems} items`)
      }
    }
  }

  return [...items.values()]
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
  dependencies: PendingDependencyLookup
  nodeId: string
  hubId: string
  streamId: string
  scanLimit?: number
  entityLimit?: number
  dependencyClosureLimit?: number
}): Promise<FrozenReplicationBatch | null> {
  const stream = await input.store.getStream(input.streamId)
  if (!stream) throw new Error(`Unknown replication stream: ${input.streamId}`)
  const pending = await input.store.listPending(input.streamId, input.scanLimit ?? 1000)
  const compatible = selectCompatiblePending(pending)
  const closure = await expandPendingDependencyClosure({
    seed: compatible,
    lookup: input.dependencies,
    streamId: stream.streamId,
    generationId: stream.generationId,
    ...(input.dependencyClosureLimit === undefined ? {} : { maxItems: input.dependencyClosureLimit }),
  })
  const built = buildReplicationBatch({
    nodeId: input.nodeId,
    hubId: input.hubId,
    stream,
    pending: closure,
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
