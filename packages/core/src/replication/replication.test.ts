import assert from 'node:assert/strict'
import test from 'node:test'
import { sha256Hex } from './hash'
import {
  agentProductSharedRootAssertion,
  assetDefinitionSharedGroupMembership,
  assetUpstreamPortableIdentity,
  buildSharedIdentityState,
  createOriginEntityRef,
  isReplicatedEntityType,
  normalizeRepositoryIdentity,
  projectRepositoryPortableIdentity,
  projectSharedGroupMembership,
  replicaIdentityFor,
  replicationEntityScope,
} from './index'

test('pure TypeScript SHA-256 matches the standard vector', () => {
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
})

test('Entity Scope Registry follows the frozen Alpha scopes and defaults unknown entities to node-scoped', () => {
  assert.equal(replicationEntityScope('AgentProduct'), 'shared')
  assert.equal(replicationEntityScope('Project'), 'conditional-shared')
  assert.equal(replicationEntityScope('AssetDefinition'), 'conditional-shared')
  assert.equal(replicationEntityScope('ToolDefinition'), 'node-scoped')
  assert.equal(replicationEntityScope('Interaction'), 'not-replicated')
  assert.equal(replicationEntityScope('FutureEntity'), 'node-scoped')
  assert.equal(isReplicatedEntityType('Projection'), false)
  assert.equal(isReplicatedEntityType('FutureEntity'), true)
})

test('ReplicaKey is stable for one origin and isolates identical local IDs from different Nodes', () => {
  const entityA = createOriginEntityRef(
    'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    'LogicalSession',
    'session-abc',
  )
  const entityB = createOriginEntityRef(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'LogicalSession',
    'session-abc',
  )

  const first = replicaIdentityFor(entityA)
  const again = replicaIdentityFor(createOriginEntityRef(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'LogicalSession',
    'session-abc',
  ))
  const otherNode = replicaIdentityFor(entityB)

  assert.equal(first.replicaKey, again.replicaKey)
  assert.notEqual(first.replicaKey, otherNode.replicaKey)
  assert.match(first.replicaKey, /^replica-r1-[0-9a-f]{64}$/)
  assert.equal(first.origin.originEntityId, 'session-abc')
})

test('project-repository-v1 normalizes equivalent GitHub remotes without accepting local paths', () => {
  const https = projectRepositoryPortableIdentity(
    'https://user:secret@GitHub.com/Acme/Agent-Lens.git?token=hidden#readme',
  )
  const ssh = projectRepositoryPortableIdentity('ssh://git@github.com:22/acme/agent-lens.git')
  const scp = projectRepositoryPortableIdentity('git@github.com:ACME/AGENT-LENS.git')

  assert.deepEqual(https, {
    algorithm: 'project-repository-v1',
    normalized: 'github.com/acme/agent-lens',
  })
  assert.deepEqual(ssh, https)
  assert.deepEqual(scp, https)
  assert.equal(projectRepositoryPortableIdentity('/home/me/agent-lens'), null)
  assert.equal(projectRepositoryPortableIdentity('C:\\work\\agent-lens'), null)
  assert.equal(projectRepositoryPortableIdentity('agent-lens'), null)
  assert.equal(normalizeRepositoryIdentity('file:///tmp/agent-lens'), null)
  assert.equal(normalizeRepositoryIdentity('ssh://git@localhost/repo.git'), null)
})

test('unknown Git providers preserve path case instead of guessing provider semantics', () => {
  assert.equal(
    normalizeRepositoryIdentity('ssh://git@Git.Example.com/Team/Repo.git'),
    'git.example.com/Team/Repo',
  )
  assert.notEqual(
    normalizeRepositoryIdentity('ssh://git@git.example.com/Team/Repo.git'),
    normalizeRepositoryIdentity('ssh://git@git.example.com/team/repo.git'),
  )
})

test('same portable Project identity joins one Shared Group while preserving distinct origins', () => {
  const originA = createOriginEntityRef('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Project', 'project-local-a')
  const originB = createOriginEntityRef('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Project', 'project-local-b')
  const memberA = projectSharedGroupMembership(originA, 'https://github.com/acme/project.git')
  const memberB = projectSharedGroupMembership(originB, 'git@github.com:ACME/PROJECT.git')
  if (!memberA || !memberB) assert.fail('portable Project identities must create memberships')

  assert.equal(memberA.key, memberB.key)
  assert.notEqual(memberA.replicaKey, memberB.replicaKey)
  assert.equal(memberA.origin.originEntityId, 'project-local-a')
  assert.equal(memberB.origin.originEntityId, 'project-local-b')

  const state = buildSharedIdentityState({ memberships: [memberB, memberA] })
  assert.equal(state.groups.length, 1)
  assert.deepEqual(
    state.groups[0]!.members.map(item => item.origin.originEntityId),
    ['project-local-a', 'project-local-b'],
  )
})

test('Project names and local repository roots never create Conditional Shared membership', () => {
  const origin = createOriginEntityRef('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Project', 'project-local')
  assert.equal(projectSharedGroupMembership(origin, 'my-project'), null)
  assert.equal(projectSharedGroupMembership(origin, '/Users/me/my-project'), null)
  assert.equal(projectSharedGroupMembership(origin, undefined), null)
})

test('asset-upstream-v1 accepts portable repository or explicit namespaced identities only', () => {
  assert.deepEqual(
    assetUpstreamPortableIdentity('git@github.com:acme/tooling.git'),
    {
      algorithm: 'asset-upstream-v1',
      normalized: 'repository:github.com/acme/tooling',
    },
  )
  assert.deepEqual(
    assetUpstreamPortableIdentity('npm:@acme/agent-skill'),
    {
      algorithm: 'asset-upstream-v1',
      normalized: 'npm:@acme/agent-skill',
    },
  )
  assert.equal(assetUpstreamPortableIdentity('agent-skill'), null)
  assert.equal(assetUpstreamPortableIdentity('/home/me/.agent/skills/foo'), null)
  assert.equal(assetUpstreamPortableIdentity('C:\\skills\\foo'), null)
})

test('AssetDefinition membership keeps the origin identity instead of rewriting domain references', () => {
  const origin = createOriginEntityRef(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'AssetDefinition',
    'asset-local-123',
  )
  const membership = assetDefinitionSharedGroupMembership(origin, 'npm:@acme/skill')
  if (!membership) assert.fail('portable AssetDefinition identity must create membership')
  assert.equal(membership.origin, origin)
  assert.equal(membership.origin.originEntityId, 'asset-local-123')
  assert.match(membership.key, /^shared-group-r1-[0-9a-f]{64}$/)
})

test('Shared Identity state is deterministic regardless of assertion arrival order', () => {
  const projectA = projectSharedGroupMembership(
    createOriginEntityRef('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Project', 'project-a'),
    'https://github.com/acme/project.git',
  )
  const projectB = projectSharedGroupMembership(
    createOriginEntityRef('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Project', 'project-b'),
    'git@github.com:acme/project.git',
  )
  if (!projectA || !projectB) assert.fail('portable Project identities must create memberships')

  const productA = agentProductSharedRootAssertion(
    createOriginEntityRef('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'AgentProduct', 'claude'),
  )
  const productB = agentProductSharedRootAssertion(
    createOriginEntityRef('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'AgentProduct', 'claude'),
  )

  const first = buildSharedIdentityState({
    rootAssertions: [productA, productB],
    memberships: [projectA, projectB],
  })
  const reversed = buildSharedIdentityState({
    rootAssertions: [productB, productA],
    memberships: [projectB, projectA],
  })

  assert.deepEqual(first, reversed)
  assert.equal(first.roots.length, 1)
  assert.equal(first.roots[0]!.assertions.length, 2)
  assert.equal(first.groups.length, 1)
  assert.equal(first.groups[0]!.members.length, 2)
})

test('one Conditional Shared origin cannot silently belong to two groups', () => {
  const origin = createOriginEntityRef('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Project', 'project-a')
  const first = projectSharedGroupMembership(origin, 'https://github.com/acme/one.git')
  const second = projectSharedGroupMembership(origin, 'https://github.com/acme/two.git')
  if (!first || !second) assert.fail('portable Project identities must create memberships')

  assert.throws(
    () => buildSharedIdentityState({ memberships: [first, second] }),
    /assigned to multiple groups/,
  )
})
