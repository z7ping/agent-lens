export type ReplicationEntityScope =
  | 'shared'
  | 'conditional-shared'
  | 'node-scoped'
  | 'not-replicated'

export const KNOWN_REPLICATION_ENTITY_TYPES = [
  'AgentProduct',
  'Project',
  'AssetDefinition',
  'Host',
  'AgentInstallation',
  'RuntimeProfile',
  'Workspace',
  'LogicalSession',
  'SourceSession',
  'SessionRelationship',
  'AgentActor',
  'SourceRecord',
  'Evidence',
  'CanonicalObservation',
  'Coverage',
  'AssetBinding',
  'AssetStateObservation',
  'ToolDefinition',
  'Interaction',
  'SessionRelationshipCandidate',
  'SourceCheckpoint',
  'SourceRuntimeStatus',
  'Projection',
  'Summary',
  'Usage',
  'Overview',
  'ReplicationControlPlane',
] as const

export type KnownReplicationEntityType = typeof KNOWN_REPLICATION_ENTITY_TYPES[number]
export type SharedRootEntityType = 'AgentProduct'
export type ConditionalSharedEntityType = 'Project' | 'AssetDefinition'

export interface EntityRef<T extends string = string> {
  entityType: T
  entityId: string
}

export interface OriginEntityRef<T extends string = string> {
  originNodeId: string
  entityType: T
  originEntityId: string
}

export type ReplicaKey = `replica-r1-${string}`
export type SharedRootKey = `shared-root-r1-${string}`
export type SharedGroupKey = `shared-group-r1-${string}`

export interface ReplicaIdentity<T extends string = string> {
  origin: OriginEntityRef<T>
  replicaKey: ReplicaKey
}

export type SharedIdentityAlgorithm = 'project-repository-v1' | 'asset-upstream-v1'

export interface PortableIdentity<A extends SharedIdentityAlgorithm = SharedIdentityAlgorithm> {
  algorithm: A
  normalized: string
}

export interface SharedRootAssertion {
  key: SharedRootKey
  entityType: SharedRootEntityType
  stableIdentity: string
  origin: OriginEntityRef<SharedRootEntityType>
  replicaKey: ReplicaKey
}

export interface SharedGroupMembership<T extends ConditionalSharedEntityType = ConditionalSharedEntityType> {
  key: SharedGroupKey
  entityType: T
  portableIdentity: PortableIdentity
  origin: OriginEntityRef<T>
  replicaKey: ReplicaKey
}

export interface SharedRoot {
  key: SharedRootKey
  entityType: SharedRootEntityType
  stableIdentity: string
  assertions: SharedRootAssertion[]
}

export interface SharedGroup<T extends ConditionalSharedEntityType = ConditionalSharedEntityType> {
  key: SharedGroupKey
  entityType: T
  portableIdentity: PortableIdentity
  members: SharedGroupMembership<T>[]
}

export interface SharedIdentityState {
  roots: SharedRoot[]
  groups: SharedGroup[]
}
