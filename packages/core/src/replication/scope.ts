import type {
  KnownReplicationEntityType,
  ReplicationEntityScope,
} from './types'

export const REPLICATION_ENTITY_SCOPE_REGISTRY: Readonly<Record<KnownReplicationEntityType, ReplicationEntityScope>> = {
  AgentProduct: 'shared',
  Project: 'conditional-shared',
  AssetDefinition: 'conditional-shared',

  Host: 'node-scoped',
  AgentInstallation: 'node-scoped',
  RuntimeProfile: 'node-scoped',
  Workspace: 'node-scoped',
  LogicalSession: 'node-scoped',
  SourceSession: 'node-scoped',
  SessionRelationship: 'node-scoped',
  AgentActor: 'node-scoped',
  SourceRecord: 'node-scoped',
  Evidence: 'node-scoped',
  CanonicalObservation: 'node-scoped',
  Coverage: 'node-scoped',
  AssetBinding: 'node-scoped',
  AssetStateObservation: 'node-scoped',
  ToolDefinition: 'node-scoped',

  Interaction: 'not-replicated',
  SessionRelationshipCandidate: 'not-replicated',
  SourceCheckpoint: 'not-replicated',
  SourceRuntimeStatus: 'not-replicated',
  Projection: 'not-replicated',
  Summary: 'not-replicated',
  Usage: 'not-replicated',
  Overview: 'not-replicated',
  ReplicationControlPlane: 'not-replicated',
}

export function replicationEntityScope(entityType: string): ReplicationEntityScope {
  return REPLICATION_ENTITY_SCOPE_REGISTRY[entityType as KnownReplicationEntityType] ?? 'node-scoped'
}

export function isReplicatedEntityType(entityType: string): boolean {
  return replicationEntityScope(entityType) !== 'not-replicated'
}
