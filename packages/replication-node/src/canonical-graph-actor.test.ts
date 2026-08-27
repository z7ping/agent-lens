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
  SourceSession,
} from '@agent-lens/core'
import {
  generateObservationReplicaGraph,
  type CanonicalReplicationReader,
} from './canonical-graph'

const host: Host = {
  id: 'host-1',
  name: 'devbox',
  platform: 'linux',
  arch: 'x64',
  createdAt: '2026-08-01T00:00:00.000Z',
  lastSeenAt: '2026-08-28T00:00:00.000Z',
}
const product: AgentProduct = { id: 'claude-code', name: 'Claude Code' }
const installation: AgentInstallation = {
  id: 'installation-1',
  hostId: host.id,
  productId: product.id,
  firstSeenAt: '2026-08-01T00:00:00.000Z',
  lastSeenAt: '2026-08-28T00:00:00.000Z',
}
const logicalSession: LogicalSession = {
  id: 'logical-1',
  installationId: installation.id,
  startedAt: '2026-08-28T00:00:00.000Z',
}
const sourceSession: SourceSession = {
  id: 'source-1',
  sourceId: 'claude',
  installationId: installation.id,
  nativeSessionId: 'native-1',
  logicalSessionId: logicalSession.id,
}
const actorEvidence: Evidence = {
  id: 'evidence-actor',
  captureMethod: 'history',
  derivation: 'direct',
  confidence: 'high',
  capturedAt: '2026-08-28T00:00:01.000Z',
}
const actor: AgentActor = {
  id: 'actor-1',
  installationId: installation.id,
  logicalSessionId: logicalSession.id,
  role: 'main-agent',
  evidenceRefs: [actorEvidence.id],
}
const observation: CanonicalObservation = {
  id: 'observation-1',
  hostId: host.id,
  installationId: installation.id,
  logicalSessionId: logicalSession.id,
  sourceSessionId: sourceSession.id,
  actorId: actor.id,
  kind: 'message.assistant',
  capturedAt: '2026-08-28T00:00:02.000Z',
  payload: { text: 'done' },
  evidenceRefs: [],
}

function baseReader(actorLoader: (id: string) => Promise<AgentActor | null>): CanonicalReplicationReader {
  return {
    getHost: async id => id === host.id ? host : null,
    getInstallation: async id => id === installation.id ? installation : null,
    getAgentProduct: async id => id === product.id ? product : null,
    getProject: async () => null,
    getWorkspace: async () => null,
    getRuntimeProfile: async () => null,
    getLogicalSession: async id => id === logicalSession.id ? logicalSession : null,
    getSourceSession: async id => id === sourceSession.id ? sourceSession : null,
    getActor: actorLoader,
    getEvidence: async id => id === actorEvidence.id ? actorEvidence : null,
    getSourceRecord: async () => null,
  }
}

const common = {
  nodeId: 'node-a',
  observation,
  phase: 'bootstrap' as const,
  policy: { mode: 'full' as const, revision: 'policy-1' },
  history: { mode: 'include-existing' as const, revision: 'history-1' },
}

test('Actor evidence is materialized before the Actor envelope', async () => {
  const result = await generateObservationReplicaGraph({
    ...common,
    reader: baseReader(async id => id === actor.id ? actor : null),
  })
  assert.equal(result.kind, 'graph')
  if (result.kind !== 'graph') return

  const types = result.entities.map(entity => `${entity.entityType}:${entity.originEntityId}`)
  const evidenceIndex = types.indexOf(`Evidence:${actorEvidence.id}`)
  const actorIndex = types.indexOf(`AgentActor:${actor.id}`)
  assert.ok(evidenceIndex >= 0)
  assert.ok(actorIndex > evidenceIndex)
})

test('Actor parent cycle fails closed instead of recursing indefinitely', async () => {
  const actorA: AgentActor = {
    ...actor,
    id: 'actor-a',
    parentActorId: 'actor-b',
    evidenceRefs: [],
  }
  const actorB: AgentActor = {
    ...actor,
    id: 'actor-b',
    parentActorId: 'actor-a',
    evidenceRefs: [],
  }

  await assert.rejects(
    generateObservationReplicaGraph({
      ...common,
      observation: { ...observation, actorId: actorA.id },
      reader: baseReader(async id => id === actorA.id ? actorA : id === actorB.id ? actorB : null),
    }),
    /Replication dependency cycle: AgentActor:actor-a/,
  )
})
