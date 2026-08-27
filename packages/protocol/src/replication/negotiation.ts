import {
  REPLICATION_PROTOCOL,
  ReplicationProtocolError,
  type EntityVersionSupport,
  type ProtocolVersion,
} from './types'
import {
  SUPPORTED_ENTITY_VERSIONS,
  SUPPORTED_IDENTITY_ALGORITHMS,
} from './validation'

export interface NegotiatedCompatibility {
  protocol: ProtocolVersion
  identityAlgorithms: readonly string[]
  entityVersions: readonly EntityVersionSupport[]
}

export function negotiateProtocolVersion(remote: ProtocolVersion): ProtocolVersion {
  if (remote.major !== REPLICATION_PROTOCOL.major) {
    throw new ReplicationProtocolError(
      'PROTOCOL_VERSION_UNSUPPORTED',
      `No common replication protocol major for R${remote.major}.${remote.minor}`,
    )
  }
  return {
    major: REPLICATION_PROTOCOL.major,
    minor: Math.min(REPLICATION_PROTOCOL.minor, remote.minor),
  }
}

export function negotiateIdentityAlgorithms(remote: readonly string[]): readonly string[] {
  const selected = SUPPORTED_IDENTITY_ALGORITHMS.filter(algorithm => remote.includes(algorithm))
  if (selected.length === 0) {
    throw new ReplicationProtocolError(
      'IDENTITY_ALGORITHM_UNSUPPORTED',
      'No common shared identity algorithm',
    )
  }
  return selected
}

export function negotiateEntityVersions(remote: readonly EntityVersionSupport[]): readonly EntityVersionSupport[] {
  const selected: EntityVersionSupport[] = []
  for (const remoteSupport of remote) {
    const local = SUPPORTED_ENTITY_VERSIONS[remoteSupport.entityType]
    if (!local) continue
    const common = remoteSupport.versions.filter(version => local.includes(version)).sort((a, b) => b - a)
    if (common.length) {
      selected.push({ entityType: remoteSupport.entityType, versions: [common[0]!] })
    }
  }
  selected.sort((a, b) => a.entityType.localeCompare(b.entityType))
  if (selected.length === 0) {
    throw new ReplicationProtocolError(
      'ENTITY_VERSION_UNSUPPORTED',
      'No common replication entity version',
    )
  }
  return selected
}

export function negotiateCompatibility(input: {
  protocol: ProtocolVersion
  identityAlgorithms: readonly string[]
  entityVersions: readonly EntityVersionSupport[]
}): NegotiatedCompatibility {
  return {
    protocol: negotiateProtocolVersion(input.protocol),
    identityAlgorithms: negotiateIdentityAlgorithms(input.identityAlgorithms),
    entityVersions: negotiateEntityVersions(input.entityVersions),
  }
}
