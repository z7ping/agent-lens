import {
  REPLICA_KEY_ALGORITHM,
  SHARED_GROUP_KEY_ALGORITHM,
  SHARED_ROOT_KEY_ALGORITHM,
  createOriginEntityRef,
  replicaKeyFor,
  replicationEntityScope,
  sharedGroupKeyFor,
  sharedRootKeyFor,
  type ConditionalSharedEntityType,
  type KnownReplicationEntityType,
  type PortableIdentity,
} from '@agent-lens/core/replication'
import {
  ReplicationProtocolError,
  assertReplicationBatch,
  type JsonValue,
  type ReplicationBatch,
  type WireEntityEnvelope,
  type WireEntityRef,
} from '@agent-lens/protocol/replication'

export type HubReplicaGenerationStatus = 'staged' | 'active' | 'retired'
export type HubReplicationStreamStatus = 'active' | 'paused' | 'revoked'

export interface HubReplicaGenerationRecord {
  originNodeId: string
  generationId: string
  status: HubReplicaGenerationStatus
  createdAt: string
  activatedAt?: string
  retiredAt?: string
}

export interface HubReplicationStreamRecord {
  streamId: string
  originNodeId: string
  status: HubReplicationStreamStatus
  ackSequence: number
  createdAt: string
  updatedAt: string
}

export interface HubCommittedBatchRecord {
  streamId: string
  sequence: number
  originNodeId: string
  generationId: string
  batchId: string
  contentHash: string
  committedAt: string
}

export interface HubRemoteReplicaEntityRecord {
  originNodeId: string
  generationId: string
  entityType: KnownReplicationEntityType
  originEntityId: string
  replicaKey: string
  scope: WireEntityEnvelope['scope']
  entityVersion: number
  contentHash: string
  body: JsonValue
  references?: WireEntityEnvelope['references']
  sharedIdentity?: WireEntityEnvelope['sharedIdentity']
  updatedSequence: number
  updatedAt: string
}

export interface HubRemoteSharedIdentityRecord {
  originNodeId: string
  generationId: string
  entityType: KnownReplicationEntityType
  originEntityId: string
  stateKind: 'shared-root' | 'conditional-membership'
  identityAlgorithm: string
  normalizedIdentity?: string
  sharedKey: string
  updatedSequence: number
  updatedAt: string
}

export interface HubReplicaStoreTransaction {
  getStream(streamId: string): Promise<HubReplicationStreamRecord | undefined>
  putStream(record: HubReplicationStreamRecord): Promise<void>
  getGeneration(originNodeId: string, generationId: string): Promise<HubReplicaGenerationRecord | undefined>
  putGeneration(record: HubReplicaGenerationRecord): Promise<void>
  getCommittedBatch(streamId: string, sequence: number): Promise<HubCommittedBatchRecord | undefined>
  putCommittedBatch(record: HubCommittedBatchRecord): Promise<void>
  putEntity(record: HubRemoteReplicaEntityRecord): Promise<void>
  hasEntity(input: {
    originNodeId: string
    generationId: string
    entityType: string
    originEntityId: string
  }): Promise<boolean>
  putSharedIdentity(record: HubRemoteSharedIdentityRecord): Promise<void>
  hasSharedIdentityKey(input: {
    originNodeId: string
    generationId: string
    entityType: string
    sharedKey: string
  }): Promise<boolean>
  setStreamAck(streamId: string, ackSequence: number, updatedAt: string): Promise<void>
  activateGeneration(originNodeId: string, generationId: string, activatedAt: string): Promise<void>
}

export interface HubReplicaStore {
  transaction<T>(operation: (tx: HubReplicaStoreTransaction) => Promise<T>): Promise<T>
}

export type HubBatchImportResult =
  | { status: 'committed'; ackSequence: number }
  | { status: 'exact-retry'; ackSequence: number }

function protocolError(message: string): never {
  throw new ReplicationProtocolError('BATCH_INVALID', message)
}

function nodeRefKey(entityType: string, originEntityId: string): string {
  return `${entityType}\u0000${originEntityId}`
}

function refs(entity: WireEntityEnvelope): readonly WireEntityRef[] {
  const result: WireEntityRef[] = []
  for (const value of Object.values(entity.references ?? {})) {
    if (Array.isArray(value)) result.push(...value)
    else result.push(value as WireEntityRef)
  }
  return result
}

function conditionalSharedType(entityType: string): ConditionalSharedEntityType | undefined {
  if (entityType === 'Project' || entityType === 'AssetDefinition') return entityType
  return undefined
}

function expectedConditionalAlgorithm(entityType: ConditionalSharedEntityType): PortableIdentity['algorithm'] {
  return entityType === 'Project' ? 'project-repository-v1' : 'asset-upstream-v1'
}

function expectedWireScope(entityType: string): WireEntityEnvelope['scope'] {
  const scope = replicationEntityScope(entityType)
  if (scope === 'not-replicated') protocolError(`${entityType} is not replicated on R1`)
  return scope === 'shared' ? 'shared' : 'node'
}

function validateAndBuildIdentityState(input: {
  originNodeId: string
  generationId: string
  sequence: number
  entity: WireEntityEnvelope
  updatedAt: string
}): HubRemoteSharedIdentityRecord | undefined {
  const { entity } = input
  if (entity.entityType === 'AgentProduct') {
    return {
      originNodeId: input.originNodeId,
      generationId: input.generationId,
      entityType: 'AgentProduct',
      originEntityId: entity.originEntityId,
      stateKind: 'shared-root',
      identityAlgorithm: SHARED_ROOT_KEY_ALGORITHM,
      sharedKey: sharedRootKeyFor('AgentProduct', entity.originEntityId),
      updatedSequence: input.sequence,
      updatedAt: input.updatedAt,
    }
  }

  if (!entity.sharedIdentity) return undefined
  const entityType = conditionalSharedType(entity.entityType)
  if (!entityType) protocolError(`${entity.entityType} cannot assert conditional shared identity`)
  const expectedAlgorithm = expectedConditionalAlgorithm(entityType)
  if (entity.sharedIdentity.identityAlgorithm !== expectedAlgorithm) {
    protocolError(`${entityType} shared identity algorithm mismatch`)
  }
  const portableIdentity: PortableIdentity = {
    algorithm: expectedAlgorithm,
    normalized: entity.sharedIdentity.normalizedPortableIdentity,
  }
  const expectedKey = sharedGroupKeyFor(entityType, portableIdentity)
  if (entity.sharedIdentity.claimedSharedKey !== expectedKey) {
    throw new ReplicationProtocolError('SHARED_IDENTITY_MISMATCH', `${entityType} shared key mismatch`)
  }
  return {
    originNodeId: input.originNodeId,
    generationId: input.generationId,
    entityType,
    originEntityId: entity.originEntityId,
    stateKind: 'conditional-membership',
    identityAlgorithm: expectedAlgorithm,
    normalizedIdentity: entity.sharedIdentity.normalizedPortableIdentity,
    sharedKey: expectedKey,
    updatedSequence: input.sequence,
    updatedAt: input.updatedAt,
  }
}

async function assertReferencesResolvable(input: {
  tx: HubReplicaStoreTransaction
  batch: ReplicationBatch
  entity: WireEntityEnvelope
  sameBatchNodeRefs: ReadonlySet<string>
  sameBatchSharedRefs: ReadonlySet<string>
}): Promise<void> {
  for (const ref of refs(input.entity)) {
    if (ref.kind === 'node') {
      const key = nodeRefKey(ref.entityType, ref.originEntityId)
      if (input.sameBatchNodeRefs.has(key)) continue
      const exists = await input.tx.hasEntity({
        originNodeId: input.batch.nodeId,
        generationId: input.batch.generationId,
        entityType: ref.entityType,
        originEntityId: ref.originEntityId,
      })
      if (!exists) {
        throw new ReplicationProtocolError('ENTITY_REFERENCE_INVALID', `Missing node reference ${ref.entityType}:${ref.originEntityId}`)
      }
      continue
    }

    const sharedKey = `${ref.entityType}\u0000${ref.sharedKey}`
    if (input.sameBatchSharedRefs.has(sharedKey)) continue
    const exists = await input.tx.hasSharedIdentityKey({
      originNodeId: input.batch.nodeId,
      generationId: input.batch.generationId,
      entityType: ref.entityType,
      sharedKey: ref.sharedKey,
    })
    if (!exists) {
      throw new ReplicationProtocolError('ENTITY_REFERENCE_INVALID', `Missing shared reference ${ref.entityType}:${ref.sharedKey}`)
    }
  }
}

export async function importReplicationBatch(input: {
  store: HubReplicaStore
  batch: ReplicationBatch
  now?: string
}): Promise<HubBatchImportResult> {
  assertReplicationBatch(input.batch)
  if ((input.batch.tombstones?.length ?? 0) > 0) {
    protocolError('H7 Remote Replica importer does not support tombstones yet')
  }

  const now = input.now ?? new Date().toISOString()
  return input.store.transaction(async tx => {
    let stream = await tx.getStream(input.batch.streamId)
    if (!stream) {
      stream = {
        streamId: input.batch.streamId,
        originNodeId: input.batch.nodeId,
        status: 'active',
        ackSequence: 0,
        createdAt: now,
        updatedAt: now,
      }
      await tx.putStream(stream)
    }
    if (stream.originNodeId !== input.batch.nodeId) {
      protocolError('Replication stream belongs to a different origin node')
    }
    if (stream.status !== 'active') {
      protocolError(`Replication stream is not active: ${stream.status}`)
    }

    if (input.batch.sequence <= stream.ackSequence) {
      const committed = await tx.getCommittedBatch(input.batch.streamId, input.batch.sequence)
      if (
        committed
        && committed.batchId === input.batch.batchId
        && committed.contentHash === input.batch.contentHash
        && committed.originNodeId === input.batch.nodeId
        && committed.generationId === input.batch.generationId
      ) {
        return { status: 'exact-retry', ackSequence: stream.ackSequence }
      }
      throw new ReplicationProtocolError('SEQUENCE_REUSE_CONFLICT', `Sequence ${input.batch.sequence} was already committed with different content`)
    }
    if (input.batch.sequence !== stream.ackSequence + 1) {
      throw new ReplicationProtocolError('SEQUENCE_GAP', `Expected sequence ${stream.ackSequence + 1}, got ${input.batch.sequence}`)
    }

    let generation = await tx.getGeneration(input.batch.nodeId, input.batch.generationId)
    if (!generation) {
      generation = {
        originNodeId: input.batch.nodeId,
        generationId: input.batch.generationId,
        status: 'staged',
        createdAt: now,
      }
      await tx.putGeneration(generation)
    }
    if (generation.status === 'retired') {
      protocolError(`Replica generation is retired: ${input.batch.generationId}`)
    }

    const sameBatchNodeRefs = new Set<string>()
    const sameBatchSharedRefs = new Set<string>()
    for (const entity of input.batch.entities) {
      sameBatchNodeRefs.add(nodeRefKey(entity.entityType, entity.originEntityId))
      if (entity.entityType === 'AgentProduct') {
        sameBatchSharedRefs.add(`AgentProduct\u0000${sharedRootKeyFor('AgentProduct', entity.originEntityId)}`)
      }
    }

    for (const entity of input.batch.entities) {
      const expectedScope = expectedWireScope(entity.entityType)
      if (entity.scope !== expectedScope) {
        throw new ReplicationProtocolError('ENTITY_SCOPE_INVALID', `${entity.entityType} scope mismatch: expected ${expectedScope}`)
      }
      const origin = createOriginEntityRef(input.batch.nodeId, entity.entityType, entity.originEntityId)
      const expectedReplicaKey = replicaKeyFor(origin)
      if (entity.replicaKey && entity.replicaKey !== expectedReplicaKey) {
        throw new ReplicationProtocolError('BATCH_INVALID', `${entity.entityType} replicaKey mismatch`)
      }
      await assertReferencesResolvable({
        tx,
        batch: input.batch,
        entity,
        sameBatchNodeRefs,
        sameBatchSharedRefs,
      })

      await tx.putEntity({
        originNodeId: input.batch.nodeId,
        generationId: input.batch.generationId,
        entityType: entity.entityType as KnownReplicationEntityType,
        originEntityId: entity.originEntityId,
        replicaKey: expectedReplicaKey,
        scope: expectedScope,
        entityVersion: entity.entityVersion,
        contentHash: entity.contentHash,
        body: entity.body,
        ...(entity.references === undefined ? {} : { references: entity.references }),
        ...(entity.sharedIdentity === undefined ? {} : { sharedIdentity: entity.sharedIdentity }),
        updatedSequence: input.batch.sequence,
        updatedAt: now,
      })

      const sharedState = validateAndBuildIdentityState({
        originNodeId: input.batch.nodeId,
        generationId: input.batch.generationId,
        sequence: input.batch.sequence,
        entity,
        updatedAt: now,
      })
      if (sharedState) await tx.putSharedIdentity(sharedState)
    }

    await tx.putCommittedBatch({
      streamId: input.batch.streamId,
      sequence: input.batch.sequence,
      originNodeId: input.batch.nodeId,
      generationId: input.batch.generationId,
      batchId: input.batch.batchId,
      contentHash: input.batch.contentHash,
      committedAt: now,
    })
    await tx.setStreamAck(input.batch.streamId, input.batch.sequence, now)
    return { status: 'committed', ackSequence: input.batch.sequence }
  })
}

export async function activateReplicaGeneration(input: {
  store: HubReplicaStore
  originNodeId: string
  generationId: string
  now?: string
}): Promise<void> {
  const now = input.now ?? new Date().toISOString()
  await input.store.transaction(async tx => {
    const generation = await tx.getGeneration(input.originNodeId, input.generationId)
    if (!generation) throw new Error(`Unknown replica generation: ${input.originNodeId}/${input.generationId}`)
    if (generation.status === 'retired') throw new Error('Cannot activate a retired replica generation')
    await tx.activateGeneration(input.originNodeId, input.generationId, now)
  })
}

export const HUB_REPLICA_KEY_ALGORITHM = REPLICA_KEY_ALGORITHM
export const HUB_SHARED_GROUP_KEY_ALGORITHM = SHARED_GROUP_KEY_ALGORITHM
