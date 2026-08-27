import {
  replicaKeyFor,
  sharedGroupKeyFor,
  sharedRootKeyFor,
} from './keys'
import {
  assetUpstreamPortableIdentity,
  projectRepositoryPortableIdentity,
} from './portable-identity'
import type {
  ConditionalSharedEntityType,
  OriginEntityRef,
  PortableIdentity,
  SharedGroup,
  SharedGroupMembership,
  SharedIdentityState,
  SharedRoot,
  SharedRootAssertion,
} from './types'

function originIdentity(ref: OriginEntityRef): string {
  return JSON.stringify([ref.originNodeId, ref.entityType, ref.originEntityId])
}

function compareOrigins(left: OriginEntityRef, right: OriginEntityRef): number {
  return left.originNodeId.localeCompare(right.originNodeId)
    || left.entityType.localeCompare(right.entityType)
    || left.originEntityId.localeCompare(right.originEntityId)
}

function assertConditionalAlgorithm(
  entityType: ConditionalSharedEntityType,
  portableIdentity: PortableIdentity,
): void {
  if (entityType === 'Project' && portableIdentity.algorithm !== 'project-repository-v1') {
    throw new Error('Project membership requires project-repository-v1')
  }
  if (entityType === 'AssetDefinition' && portableIdentity.algorithm !== 'asset-upstream-v1') {
    throw new Error('AssetDefinition membership requires asset-upstream-v1')
  }
}

export function createSharedGroupMembership<T extends ConditionalSharedEntityType>(
  origin: OriginEntityRef<T>,
  portableIdentity: PortableIdentity,
): SharedGroupMembership<T> {
  assertConditionalAlgorithm(origin.entityType, portableIdentity)
  return {
    key: sharedGroupKeyFor(origin.entityType, portableIdentity),
    entityType: origin.entityType,
    portableIdentity,
    origin,
    replicaKey: replicaKeyFor(origin),
  }
}

export function projectSharedGroupMembership(
  origin: OriginEntityRef<'Project'>,
  repositoryIdentity: string | undefined,
): SharedGroupMembership<'Project'> | null {
  const portableIdentity = projectRepositoryPortableIdentity(repositoryIdentity)
  return portableIdentity ? createSharedGroupMembership(origin, portableIdentity) : null
}

export function assetDefinitionSharedGroupMembership(
  origin: OriginEntityRef<'AssetDefinition'>,
  upstreamIdentity: string | undefined,
): SharedGroupMembership<'AssetDefinition'> | null {
  const portableIdentity = assetUpstreamPortableIdentity(upstreamIdentity)
  return portableIdentity ? createSharedGroupMembership(origin, portableIdentity) : null
}

export function agentProductSharedRootAssertion(
  origin: OriginEntityRef<'AgentProduct'>,
  stableProductIdentity: string = origin.originEntityId,
): SharedRootAssertion {
  const stableIdentity = stableProductIdentity.trim()
  if (!stableIdentity) throw new Error('stableProductIdentity must not be empty')
  return {
    key: sharedRootKeyFor('AgentProduct', stableIdentity),
    entityType: 'AgentProduct',
    stableIdentity,
    origin,
    replicaKey: replicaKeyFor(origin),
  }
}

function buildRoots(assertions: readonly SharedRootAssertion[]): SharedRoot[] {
  const byKey = new Map<string, SharedRoot>()
  const originAssignments = new Map<string, string>()

  for (const assertion of assertions) {
    const originKey = originIdentity(assertion.origin)
    const assigned = originAssignments.get(originKey)
    if (assigned && assigned !== assertion.key) {
      throw new Error(`Shared root origin assigned to multiple roots: ${originKey}`)
    }
    originAssignments.set(originKey, assertion.key)

    const current = byKey.get(assertion.key)
    if (!current) {
      byKey.set(assertion.key, {
        key: assertion.key,
        entityType: assertion.entityType,
        stableIdentity: assertion.stableIdentity,
        assertions: [assertion],
      })
      continue
    }
    if (
      current.entityType !== assertion.entityType
      || current.stableIdentity !== assertion.stableIdentity
    ) {
      throw new Error(`Shared root key collision: ${assertion.key}`)
    }
    if (!current.assertions.some(item => originIdentity(item.origin) === originKey)) {
      current.assertions.push(assertion)
    }
  }

  return [...byKey.values()]
    .map(root => ({
      ...root,
      assertions: [...root.assertions].sort((a, b) => compareOrigins(a.origin, b.origin)),
    }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

function buildGroups(memberships: readonly SharedGroupMembership[]): SharedGroup[] {
  const byKey = new Map<string, SharedGroup>()
  const originAssignments = new Map<string, string>()

  for (const membership of memberships) {
    const originKey = originIdentity(membership.origin)
    const assigned = originAssignments.get(originKey)
    if (assigned && assigned !== membership.key) {
      throw new Error(`Conditional shared origin assigned to multiple groups: ${originKey}`)
    }
    originAssignments.set(originKey, membership.key)

    const current = byKey.get(membership.key)
    if (!current) {
      byKey.set(membership.key, {
        key: membership.key,
        entityType: membership.entityType,
        portableIdentity: membership.portableIdentity,
        members: [membership],
      })
      continue
    }
    if (
      current.entityType !== membership.entityType
      || current.portableIdentity.algorithm !== membership.portableIdentity.algorithm
      || current.portableIdentity.normalized !== membership.portableIdentity.normalized
    ) {
      throw new Error(`Shared group key collision: ${membership.key}`)
    }
    if (!current.members.some(item => originIdentity(item.origin) === originKey)) {
      current.members.push(membership)
    }
  }

  return [...byKey.values()]
    .map(group => ({
      ...group,
      members: [...group.members].sort((a, b) => compareOrigins(a.origin, b.origin)),
    }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

export function buildSharedIdentityState(input: {
  rootAssertions?: readonly SharedRootAssertion[]
  memberships?: readonly SharedGroupMembership[]
}): SharedIdentityState {
  return {
    roots: buildRoots(input.rootAssertions ?? []),
    groups: buildGroups(input.memberships ?? []),
  }
}
