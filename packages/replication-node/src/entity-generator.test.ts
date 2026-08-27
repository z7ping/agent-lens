import assert from 'node:assert/strict'
import test from 'node:test'
import {
  replicaKeyFor,
  createOriginEntityRef,
  sharedRootKeyFor,
  type HistoryBoundary,
  type ReplicationPolicy,
} from '@agent-lens/core/replication'
import { assertEntityEnvelope } from '@agent-lens/protocol/replication'
import {
  agentProductSharedRef,
  generateWireEntity,
  nodeEntityRef,
} from './entity-generator'

const full: ReplicationPolicy = { mode: 'full', revision: 'policy-full' }
const metadataOnly: ReplicationPolicy = { mode: 'metadata-only', revision: 'policy-meta' }
const includeExisting: HistoryBoundary = { mode: 'include-existing', revision: 'history-all' }
const fromNow: HistoryBoundary = {
  mode: 'from-now',
  revision: 'history-now',
  boundaryCapturedAt: '2026-08-28T00:00:00.000Z',
}

test('node-scoped entity gets deterministic ReplicaKey and semantic hash', () => {
  const input = {
    nodeId: '11111111-1111-4111-8111-111111111111',
    entityType: 'Host' as const,
    originEntityId: 'host-local',
    body: {
      id: 'host-local',
      name: 'workstation',
      platform: 'win32',
      arch: 'x64',
      createdAt: '2026-08-28T00:00:00.000Z',
      lastSeenAt: '2026-08-28T00:01:00.000Z',
    },
    capturedAt: '2026-08-28T00:01:00.000Z',
    phase: 'bootstrap' as const,
    policy: full,
    history: includeExisting,
  }
  const first = generateWireEntity(input)
  const second = generateWireEntity(input)
  assert.equal(first.kind, 'entity')
  assert.equal(second.kind, 'entity')
  if (first.kind !== 'entity' || second.kind !== 'entity') return

  assert.equal(first.entity.scope, 'node')
  assert.equal(
    first.entity.replicaKey,
    replicaKeyFor(createOriginEntityRef(input.nodeId, 'Host', 'host-local')),
  )
  assert.equal(first.entity.contentHash, second.entity.contentHash)
  assert.doesNotThrow(() => assertEntityEnvelope(first.entity))
})

test('AgentProduct is a shared wire entity and references use Shared Root key', () => {
  const result = generateWireEntity({
    nodeId: 'node-a',
    entityType: 'AgentProduct',
    originEntityId: 'codex',
    body: { id: 'codex', name: 'Codex', vendor: 'OpenAI' },
    phase: 'bootstrap',
    policy: full,
    history: includeExisting,
  })
  assert.equal(result.kind, 'entity')
  if (result.kind !== 'entity') return
  assert.equal(result.entity.scope, 'shared')
  assert.equal(result.entity.replicaKey, undefined)
  assert.deepEqual(agentProductSharedRef('codex'), {
    kind: 'shared',
    entityType: 'AgentProduct',
    sharedKey: sharedRootKeyFor('AgentProduct', 'codex'),
  })
})

test('metadata-only keeps structure but omits observation body content', () => {
  const result = generateWireEntity({
    nodeId: 'node-a',
    entityType: 'CanonicalObservation',
    originEntityId: 'observation-1',
    body: {
      id: 'observation-1',
      hostId: 'host-1',
      installationId: 'install-1',
      logicalSessionId: 'logical-1',
      sourceSessionId: 'source-1',
      kind: 'message.user',
      capturedAt: '2026-08-28T00:01:00.000Z',
      payload: { text: 'private prompt' },
      evidenceRefs: [],
    },
    references: {
      host: nodeEntityRef('Host', 'host-1'),
      installation: nodeEntityRef('AgentInstallation', 'install-1'),
      logicalSession: nodeEntityRef('LogicalSession', 'logical-1'),
      sourceSession: nodeEntityRef('SourceSession', 'source-1'),
    },
    capturedAt: '2026-08-28T00:01:00.000Z',
    phase: 'incremental',
    policy: metadataOnly,
    history: includeExisting,
  })
  assert.equal(result.kind, 'entity')
  if (result.kind !== 'entity') return
  const body = result.entity.body as Record<string, unknown>
  assert.deepEqual(body.payload, { state: 'omitted', reason: 'policy' })
  assert.deepEqual(body.kind, { state: 'value', value: 'message.user' })
})

test('from-now blocks old ordinary entity but permits minimum dependency shape', () => {
  const blocked = generateWireEntity({
    nodeId: 'node-a',
    entityType: 'CanonicalObservation',
    originEntityId: 'old-observation',
    body: {
      id: 'old-observation',
      hostId: 'host-1',
      installationId: 'install-1',
      logicalSessionId: 'logical-1',
      sourceSessionId: 'source-1',
      kind: 'message.user',
      capturedAt: '2026-08-27T23:00:00.000Z',
      payload: { text: 'old prompt' },
      evidenceRefs: [],
    },
    capturedAt: '2026-08-27T23:00:00.000Z',
    phase: 'bootstrap',
    policy: full,
    history: fromNow,
  })
  assert.deepEqual(blocked, { kind: 'blocked', reason: 'history-boundary' })

  const dependency = generateWireEntity({
    nodeId: 'node-a',
    entityType: 'Project',
    originEntityId: 'project-1',
    body: {
      id: 'project-1',
      name: 'private project name',
      repositoryIdentity: 'github.com/z7ping/agent-lens',
      createdAt: '2026-08-01T00:00:00.000Z',
      lastSeenAt: '2026-08-27T23:00:00.000Z',
    },
    capturedAt: '2026-08-27T23:00:00.000Z',
    dependencyRequired: true,
    phase: 'bootstrap',
    policy: full,
    history: fromNow,
  })
  assert.equal(dependency.kind, 'entity')
  if (dependency.kind !== 'entity') return
  const body = dependency.entity.body as Record<string, unknown>
  assert.deepEqual(body.id, { state: 'value', value: 'project-1' })
  assert.deepEqual(body.repositoryIdentity, { state: 'value', value: 'github.com/z7ping/agent-lens' })
  assert.deepEqual(body.name, { state: 'omitted', reason: 'dependency-minimized' })
})
