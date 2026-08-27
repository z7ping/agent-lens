import {
  ASSET_IDENTITY_ALGORITHM,
  PROJECT_IDENTITY_ALGORITHM,
  REPLICATION_PROTOCOL,
  ReplicationProtocolError,
  type Availability,
  type ProtocolVersion,
  type ReplicationBatch,
  type SharedIdentityAssertion,
  type WireEntityEnvelope,
  type WireEntityRef,
} from './types'
import { computeBatchContentHash, computeEntityContentHash } from './canonical-json'

export const SUPPORTED_ENTITY_VERSIONS: Readonly<Record<string, readonly number[]>> = Object.freeze({
  AgentProduct: [1],
  Host: [1],
  AgentInstallation: [1],
  RuntimeProfile: [1],
  Project: [1],
  Workspace: [1],
  LogicalSession: [1],
  SourceSession: [1],
  SessionRelationship: [1],
  AgentActor: [1],
  SourceRecord: [1],
  CanonicalObservation: [1],
  Evidence: [1],
  ObservationEvidence: [1],
  Coverage: [1],
  CapabilityDeclaration: [1],
  AssetDefinition: [1],
  AssetBinding: [1],
  AssetStateObservation: [1],
  ToolDefinition: [1],
})

export const SUPPORTED_IDENTITY_ALGORITHMS = Object.freeze([
  PROJECT_IDENTITY_ALGORITHM,
  ASSET_IDENTITY_ALGORITHM,
] as const)

export function assertProtocolCompatible(version: ProtocolVersion): void {
  if (version.major !== REPLICATION_PROTOCOL.major || version.minor > REPLICATION_PROTOCOL.minor) {
    throw new ReplicationProtocolError(
      'PROTOCOL_VERSION_UNSUPPORTED',
      `Unsupported replication protocol R${version.major}.${version.minor}`,
    )
  }
}

export function assertIdentityAlgorithmSupported(algorithm: string): void {
  if (!(SUPPORTED_IDENTITY_ALGORITHMS as readonly string[]).includes(algorithm)) {
    throw new ReplicationProtocolError(
      'IDENTITY_ALGORITHM_UNSUPPORTED',
      `Unsupported identity algorithm: ${algorithm}`,
    )
  }
}

export function assertSharedIdentityAssertion(assertion: SharedIdentityAssertion): void {
  assertIdentityAlgorithmSupported(assertion.identityAlgorithm)
  if (!assertion.normalizedPortableIdentity.trim() || !assertion.claimedSharedKey.trim()) {
    throw new ReplicationProtocolError('SHARED_IDENTITY_MISMATCH', 'Shared identity assertion is incomplete')
  }
}

export function assertEntityVersionSupported(entityType: string, version: number): void {
  const supported = SUPPORTED_ENTITY_VERSIONS[entityType]
  if (!supported) {
    throw new ReplicationProtocolError('ENTITY_TYPE_UNSUPPORTED', `Unsupported entity type: ${entityType}`)
  }
  if (!supported.includes(version)) {
    throw new ReplicationProtocolError(
      'ENTITY_VERSION_UNSUPPORTED',
      `Unsupported ${entityType} entity version: ${version}`,
    )
  }
}

export function assertWireEntityRef(ref: WireEntityRef): void {
  if (!ref.entityType.trim()) {
    throw new ReplicationProtocolError('ENTITY_REFERENCE_INVALID', 'Entity reference type must not be empty')
  }
  if (ref.kind === 'node') {
    if (!ref.originEntityId.trim()) {
      throw new ReplicationProtocolError('ENTITY_REFERENCE_INVALID', 'Node reference originEntityId must not be empty')
    }
    return
  }
  if (ref.entityType !== 'AgentProduct' || !ref.sharedKey.trim()) {
    throw new ReplicationProtocolError(
      'ENTITY_REFERENCE_INVALID',
      'R1 shared references may target AgentProduct Shared Root only',
    )
  }
}

export function assertAvailability(value: Availability): void {
  if (value.state === 'value' || value.state === 'null' || value.state === 'redacted') return
  if (value.state === 'omitted' && ['policy', 'not-captured', 'history-boundary', 'dependency-minimized'].includes(value.reason)) return
  throw new ReplicationProtocolError('BATCH_INVALID', 'Invalid availability state')
}

export function assertEntityEnvelope(entity: WireEntityEnvelope): void {
  assertEntityVersionSupported(entity.entityType, entity.entityVersion)
  if (!entity.originEntityId.trim()) {
    throw new ReplicationProtocolError('BATCH_INVALID', 'originEntityId must not be empty')
  }
  if ((entity.entityType === 'Project' || entity.entityType === 'AssetDefinition') && entity.scope !== 'node') {
    throw new ReplicationProtocolError('ENTITY_SCOPE_INVALID', `${entity.entityType} must remain node scoped on R1 wire`)
  }
  if (entity.entityType === 'AgentProduct' && entity.scope !== 'shared') {
    throw new ReplicationProtocolError('ENTITY_SCOPE_INVALID', 'AgentProduct must use shared scope on R1 wire')
  }
  if (entity.sharedIdentity) assertSharedIdentityAssertion(entity.sharedIdentity)
  for (const ref of Object.values(entity.references ?? {})) {
    if (Array.isArray(ref)) for (const item of ref) assertWireEntityRef(item)
    else assertWireEntityRef(ref as WireEntityRef)
  }
  const { contentHash: _contentHash, ...withoutHash } = entity
  if (entity.contentHash !== computeEntityContentHash(withoutHash)) {
    throw new ReplicationProtocolError('ENTITY_HASH_MISMATCH', `${entity.entityType} contentHash mismatch`)
  }
}

export function assertReplicationBatch(batch: ReplicationBatch): void {
  assertProtocolCompatible(batch.protocol)
  if (!Number.isInteger(batch.sequence) || batch.sequence < 1) {
    throw new ReplicationProtocolError('BATCH_INVALID', 'Batch sequence must be a positive integer')
  }
  for (const entity of batch.entities) assertEntityEnvelope(entity)
  for (const assertion of batch.identityPromotions) assertSharedIdentityAssertion(assertion)
  const { contentHash: _contentHash, ...withoutHash } = batch
  if (batch.contentHash !== computeBatchContentHash(withoutHash)) {
    throw new ReplicationProtocolError('BATCH_HASH_MISMATCH', 'Batch contentHash mismatch')
  }
}
