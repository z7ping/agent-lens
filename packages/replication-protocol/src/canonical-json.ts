import { sha256Hex } from './hash'
import type { JsonValue, ReplicationBatch, WireEntityEnvelope, WireTombstone } from './types'

function serialize(value: JsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON does not allow non-finite numbers')
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`
  const object = value as Readonly<Record<string, JsonValue>>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${serialize(object[key]!)}`).join(',')}}`
}

export function canonicalJson(value: JsonValue): string {
  return serialize(value)
}

export function canonicalHash(value: JsonValue): string {
  return sha256Hex(canonicalJson(value))
}

function refsJson(entity: WireEntityEnvelope): JsonValue {
  if (!entity.references) return {}
  const result: Record<string, JsonValue> = {}
  for (const [name, ref] of Object.entries(entity.references)) {
    result[name] = Array.isArray(ref) ? ref as unknown as JsonValue : ref as unknown as JsonValue
  }
  return result
}

export function entitySemanticValue(entity: Omit<WireEntityEnvelope, 'contentHash'>): JsonValue {
  return {
    entityType: entity.entityType,
    scope: entity.scope,
    originEntityId: entity.originEntityId,
    entityVersion: entity.entityVersion,
    body: entity.body,
    references: refsJson(entity as WireEntityEnvelope),
    ...(entity.replicaKey ? { replicaKey: entity.replicaKey } : {}),
    ...(entity.sharedIdentity ? { sharedIdentity: entity.sharedIdentity as unknown as JsonValue } : {}),
  }
}

export function computeEntityContentHash(entity: Omit<WireEntityEnvelope, 'contentHash'>): string {
  return canonicalHash(entitySemanticValue(entity))
}

function tombstoneSemanticValue(tombstone: Omit<WireTombstone, 'contentHash'>): JsonValue {
  return {
    entityType: tombstone.entityType,
    originEntityId: tombstone.originEntityId,
    deletedAt: tombstone.deletedAt,
  }
}

export function computeTombstoneContentHash(tombstone: Omit<WireTombstone, 'contentHash'>): string {
  return canonicalHash(tombstoneSemanticValue(tombstone))
}

export function batchSemanticValue(batch: Omit<ReplicationBatch, 'contentHash'>): JsonValue {
  return {
    protocol: batch.protocol as unknown as JsonValue,
    nodeId: batch.nodeId,
    hubId: batch.hubId,
    streamId: batch.streamId,
    generationId: batch.generationId,
    sequence: batch.sequence,
    batchId: batch.batchId,
    phase: batch.phase,
    policyRevision: batch.policyRevision,
    historyRevision: batch.historyRevision,
    entities: batch.entities as unknown as JsonValue,
    identityPromotions: batch.identityPromotions as unknown as JsonValue,
    tombstones: (batch.tombstones ?? []) as unknown as JsonValue,
  }
}

export function computeBatchContentHash(batch: Omit<ReplicationBatch, 'contentHash'>): string {
  return canonicalHash(batchSemanticValue(batch))
}
