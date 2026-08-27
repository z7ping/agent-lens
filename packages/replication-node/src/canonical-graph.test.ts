import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  AgentActor,
  AgentInstallation,
  AgentProduct,
  CanonicalObservation,
  Evidence,
  Host,
  LogicalSession,
  Project,
  RuntimeProfile,
  SourceRecord,
  SourceSession,
  Workspace,
} from '@agent-lens/core'
import { assertEntityEnvelope } from '@agent-lens/protocol/replication'
import {
  generateObservationReplicaGraph,
  type CanonicalReplicationReader,
} from './canonical-graph'

const host: Host = {
  id: 'host-1',
  name: 'devbox',
  platform: 'linux',
  arch: 'x64',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-08-28T00:00:00.000Z',
}

const product: AgentProduct = {
  id: 'claude-code',
  name: 'Claude Code',
  vendor: 'Anthropic',
}

const installation: AgentInstallation = {
  id: 'installation-1',
  hostId: host.id,
  productId: product.id,
  version: '1.0.0',
  executable: '/home/alice/bin/claude',
  firstSeenAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-08-28T00:00:00.000Z',
}

const project: Project = {
  id: 'project-1',
  name: 'AgentLens',
  repositoryIdentity: 'git@github.com:z7ping/agent-lens.git',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-08-28T00:00:00.000Z',
}

const workspace: Workspace = {
  id: 'workspace-1',
  hostId: host.id,
  projectId: project.id,
  path: '/home/alice/src/agent-lens',
  repositoryId: 'repo-1',
}

const logicalSession: LogicalSession = {
  id: 'logical-1',
  installationId: installation.id,
  projectId: project.id,
  workspaceId: workspace.id,
  title: 'Hub H6',
  startedAt: '2026-08-28T00:01:00.000Z',
}

const sourceSession: SourceSession = {
  id: 'source-session-1',
  sourceId: 'claude',
  installationId: installation.id,
  nativeSessionId: 'native-1',
  logicalSessionId: logicalSession.id,
}

const actor: AgentActor = {
  id: 'actor-1',
  installationId: installation.id,
  logicalSessionId: logicalSession.id,
  role: 'main-agent',
  nativeActorId: 'main',
  evidenceRefs: [],
}

const sourceRecord: SourceRecord = {
  id: 'source-record-1',
  sourceId: 'claude',
  installationId: installation.id,
  nativeType: 'message',
  nativeId: 'native-event-1',
  capturedAt: '2026-08-28T00:02:00.000Z',
  locator: { kind: 'file', path: '/home/alice/.claude/history.jsonl', offset: 42 },
  payload: { text: 'hello' },
  parserVersion: '1',
}

const evidence: Evidence = {
  id: 'evidence-1',
  captureMethod: 'history',
  derivation: 'direct',
  confidence: 'high',
  sourceRecordId: sourceRecord.id,
  capturedAt: '2026-08-28T00:02:00.000Z',
}

const observation: CanonicalObservation = {
  id: 'observation-1',
  hostId: host.id,
  installationId: installation.id,
  projectId: project.id,
  workspaceId: workspace.id,
  logicalSessionId: logicalSession.id,
  sourceSessionId: sourceSession.id,
  actorId: actor.id,
  kind: 'message.assistant',
  capturedAt: '2026-08-28T00:03:00.000Z',
  payload: { text: 'done' },
  evidenceRefs: [evidence.id],
}

function reader(overrides: Partial<CanonicalReplicationReader> = {}): CanonicalReplicationReader {
  return {
    getHost: async id => id === host.id ? host : null,
    getInstallation: async id => id === installation.id ? installation : null,
    getAgentProduct: async id => id === product.id ? product : null,
    getProject: async id => id === project.id ? project : null,
    getWorkspace: async id => id === workspace.id ? workspace : null,
    getRuntimeProfile: async () => null,
    getLogicalSession: async id => id === logicalSession.id ? logicalSession : null,
    getSourceSession: async id => id === sourceSession.id ? sourceSession : null,
    getActor: async id => id === actor.id ? actor : null,
    getEvidence: async id => id === evidence.id ? evidence : null,
    getSourceRecord: async id => id === sourceRecord.id ? sourceRecord : null,
    ...overrides,
  }
}

const includeExisting = {
  nodeId: 'node-a',
  phase: 'bootstrap' as const,
  policy: { mode: 'full' as const, revision: 'policy-1' },
  history: { mode: 'include-existing' as const, revision: 'history-1' },
}

test('CanonicalObservation graph emits deterministic dependency-first R1 entities', async () => {
  const first = await generateObservationReplicaGraph({ ...includeExisting, reader: reader(), observation })
  const second = await generateObservationReplicaGraph({ ...includeExisting, reader: reader(), observation })
  assert.equal(first.kind, 'graph')
  assert.equal(second.kind, 'graph')
  if (first.kind !== 'graph' || second.kind !== 'graph') return

  assert.deepEqual(
    first.entities.map(entity => entity.entityType),
    [
      'Host',
      'AgentProduct',
      'AgentInstallation',
      'Project',
      'Workspace',
      'LogicalSession',
      'SourceSession',
      'AgentActor',
      'SourceRecord',
      'Evidence',
      'CanonicalObservation',
    ],
  )
  assert.deepEqual(first.entities, second.entities)
  for (const entity of first.entities) assert.doesNotThrow(() => assertEntityEnvelope(entity))

  const productEntity = first.entities.find(entity => entity.entityType === 'AgentProduct')!
  assert.equal(productEntity.scope, 'shared')
  assert.equal(productEntity.replicaKey, undefined)

  const installationEntity = first.entities.find(entity => entity.entityType === 'AgentInstallation')!
  assert.equal(installationEntity.references?.product.kind, 'shared')

  const projectEntity = first.entities.find(entity => entity.entityType === 'Project')!
  assert.equal(projectEntity.scope, 'node')
  assert.equal(projectEntity.sharedIdentity?.normalizedPortableIdentity, 'github.com/z7ping/agent-lens')

  const observationEntity = first.entities.at(-1)!
  assert.equal(observationEntity.entityType, 'CanonicalObservation')
  const evidenceRefs = observationEntity.references?.evidence
  assert.ok(Array.isArray(evidenceRefs))
  assert.equal(evidenceRefs.length, 1)
})

test('from-now blocks an old root before reading any dependencies', async () => {
  let reads = 0
  const throwingReader = reader({
    getHost: async () => { reads += 1; throw new Error('should not read') },
  })
  const result = await generateObservationReplicaGraph({
    nodeId: 'node-a',
    reader: throwingReader,
    observation: { ...observation, capturedAt: '2026-01-01T00:00:00.000Z' },
    phase: 'bootstrap',
    policy: { mode: 'full', revision: 'policy-1' },
    history: {
      mode: 'from-now',
      revision: 'history-1',
      boundaryCapturedAt: '2026-08-01T00:00:00.000Z',
    },
  })
  assert.deepEqual(result, { kind: 'blocked', reason: 'history-boundary' })
  assert.equal(reads, 0)
})

test('from-now keeps old dependencies only as minimum dependency shape', async () => {
  const result = await generateObservationReplicaGraph({
    nodeId: 'node-a',
    reader: reader(),
    observation,
    phase: 'bootstrap',
    policy: { mode: 'full', revision: 'policy-1' },
    history: {
      mode: 'from-now',
      revision: 'history-1',
      boundaryCapturedAt: '2026-08-01T00:00:00.000Z',
    },
  })
  assert.equal(result.kind, 'graph')
  if (result.kind !== 'graph') return

  const hostEntity = result.entities.find(entity => entity.entityType === 'Host')!
  assert.deepEqual((hostEntity.body as Record<string, unknown>).name, {
    state: 'omitted',
    reason: 'dependency-minimized',
  })

  const projectEntity = result.entities.find(entity => entity.entityType === 'Project')!
  assert.deepEqual((projectEntity.body as Record<string, unknown>).repositoryIdentity, {
    state: 'value',
    value: 'git@github.com:z7ping/agent-lens.git',
  })

  const root = result.entities.at(-1)!
  assert.deepEqual((root.body as Record<string, unknown>).payload, {
    state: 'value',
    value: { text: 'done' },
  })
})

test('missing referenced Canonical dependency fails closed', async () => {
  await assert.rejects(
    generateObservationReplicaGraph({
      ...includeExisting,
      reader: reader({ getProject: async () => null }),
      observation,
    }),
    /Replication dependency missing: Project:project-1/,
  )
})

test('non-JSON Canonical payload fails closed instead of mutating wire semantics', async () => {
  await assert.rejects(
    generateObservationReplicaGraph({
      ...includeExisting,
      reader: reader(),
      observation: { ...observation, payload: { invalid: Number.NaN } },
    }),
    /does not allow non-finite numbers/,
  )
})
