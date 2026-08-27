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
  return SUPPORTED_IDENTITY_ALGORITHMS.filter(algorithm => remote.includes(algorithm))
}

export function negotiateEntityVersions(remote: readonly EntityVersionSupport[]): readonly EntityVersionSupport[] {
  const selected: EntityVersionSupport[] = []
  for (const remoteSupport of remote) {
    const local = SUPPORTED_ENTITY_VERSIONS[remoteSupport.entityType]
    if (!local) continue
    const common = remoteSupport.versions.filter(version => local.includes(version)).sort((a, b) => b - a)
    if (common.length) selected.push({ entityType: remoteSupport.entityType, versions: [common[0]!] })
  }
  return selected.sort((a, b) => a.entityType.localeCompare(b.entityType))
}

export function negotiateCompatibility(input: {
  protocol: ProtocolVersion
  identityAlgorithms: readonly string[]
  entityVersions: readonly EntityVersionSupport[]
  requiredIdentityAlgorithms?: readonly string[]
  requiredEntityTypes?: readonly string[]
}): NegotiatedCompatibility {
  const protocol = negotiateProtocolVersion(input.protocol)
  const identityAlgorithms = negotiateIdentityAlgorithms(input.identityAlgorithms)
  const entityVersions = negotiateEntityVersions(input.entityVersions)

  for (const required of input.requiredIdentityAlgorithms ?? []) {
    if (!identityAlgorithms.includes(required)) {
      throw new ReplicationProtocolError(
        'IDENTITY_ALGORITHM_UNSUPPORTED',
        `Required identity algorithm is not supported: ${required}`,
      )
    }
  }

  const negotiatedEntityTypes = new Set(entityVersions.map(item => item.entityType))
  for (const required of input.requiredEntityTypes ?? []) {
    if (!negotiatedEntityTypes.has(required)) {
      throw new ReplicationProtocolError(
        'ENTITY_VERSION_UNSUPPORTED',
        `Required entity type has no common version: ${required}`,
      )
    }
  }

  return { protocol, identityAlgorithms, entityVersions }
}
