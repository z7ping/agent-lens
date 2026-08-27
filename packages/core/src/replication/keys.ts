import { sha256Hex } from './hash'
import type {
  ConditionalSharedEntityType,
  OriginEntityRef,
  PortableIdentity,
  ReplicaIdentity,
  ReplicaKey,
  SharedGroupKey,
  SharedRootKey,
} from './types'

export const REPLICA_KEY_ALGORITHM = 'agentlens-replica-r1' as const
export const SHARED_ROOT_KEY_ALGORITHM = 'agentlens-shared-root-r1' as const
export const SHARED_GROUP_KEY_ALGORITHM = 'agentlens-shared-group-r1' as const

function required(name: string, value: string): string {
  if (!value.trim()) throw new Error(`${name} must not be empty`)
  return value
}

function digest(parts: readonly string[]): string {
  return sha256Hex(JSON.stringify(parts))
}

export function createOriginEntityRef<T extends string>(
  originNodeId: string,
  entityType: T,
  originEntityId: string,
): OriginEntityRef<T> {
  return {
    originNodeId: required('originNodeId', originNodeId).toLowerCase(),
    entityType: required('entityType', entityType) as T,
    originEntityId: required('originEntityId', originEntityId),
  }
}

export function replicaKeyFor(origin: OriginEntityRef): ReplicaKey {
  const nodeId = required('originNodeId', origin.originNodeId).toLowerCase()
  const entityType = required('entityType', origin.entityType)
  const entityId = required('originEntityId', origin.originEntityId)
  return `replica-r1-${digest([
    REPLICA_KEY_ALGORITHM,
    nodeId,
    entityType,
    entityId,
  ])}`
}

export function replicaIdentityFor<T extends string>(origin: OriginEntityRef<T>): ReplicaIdentity<T> {
  return {
    origin,
    replicaKey: replicaKeyFor(origin),
  }
}

export function sharedRootKeyFor(
  entityType: 'AgentProduct',
  stableIdentity: string,
): SharedRootKey {
  return `shared-root-r1-${digest([
    SHARED_ROOT_KEY_ALGORITHM,
    required('entityType', entityType),
    required('stableIdentity', stableIdentity),
  ])}`
}

export function sharedGroupKeyFor(
  entityType: ConditionalSharedEntityType,
  portableIdentity: PortableIdentity,
): SharedGroupKey {
  return `shared-group-r1-${digest([
    SHARED_GROUP_KEY_ALGORITHM,
    required('entityType', entityType),
    required('identityAlgorithm', portableIdentity.algorithm),
    required('normalizedIdentity', portableIdentity.normalized),
  ])}`
}
