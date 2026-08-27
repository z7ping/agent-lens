import {
  REPLICATION_PROTOCOL,
  ReplicationProtocolError,
  type ProtocolVersion,
  type WireEntityEnvelope,
  type WireEntityRef,
} from './types'
import { computeEntityContentHash } from './canonical-json'

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

export function assertProtocolCompatible(version: ProtocolVersion): void {
  if (version.major !== REPLICATION_PROTOCOL.major || version.minor > REPLICATION_PROTOCOL.minor) {
    throw new ReplicationProtocolError(
      'PROTOCOL_VERSION_UNSUPPORTED',
      `Unsupported replication protocol R${version.major}.${version.minor}`,
    )
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

export function assertEntityEnvelope(entity: WireEntityEnvelope): void {
  assertEntityVersionSupported(entity.entityType, entity.entityVersion)
  if (!entity.originEntityId.trim()) {
    throw new ReplicationProtocolError('BATCH_INVALID', 'originEntityId must not be empty')
  }

  if ((entity.entityType === 'Project' || entity.entityType === 'AssetDefinition') && entity.scope !== 'node') {
    throw new ReplicationProtocolError(
      'ENTITY_SCOPE_INVALID',
      `${entity.entityType} must remain node scoped on R1 wire`,
    )
  }
  if (entity.entityType === 'AgentProduct' && entity.scope !== 'shared') {
    throw new ReplicationProtocolError('ENTITY_SCOPE_INVALID', 'AgentProduct must use shared scope on R1 wire')
  }

  for (const ref of Object.values(entity.references ?? {})) {
    if (Array.isArray(ref)) for (const item of ref) assertWireEntityRef(item)
    else assertWireEntityRef(ref as WireEntityRef)
  }

  const { contentHash: _contentHash, ...withoutHash } = entity
  const expected = computeEntityContentHash(withoutHash)
  if (entity.contentHash !== expected) {
    throw new ReplicationProtocolError('ENTITY_HASH_MISMATCH', `${entity.entityType} contentHash mismatch`)
  }
}
