import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  AgentInstallation,
  AgentProduct,
  CanonicalObservation,
  Host,
  LogicalSession,
  SourceSession,
} from '@agent-lens/core'
import type { CanonicalReplicationReader } from './canonical-graph'
import {
  captureReplicationHighWater,
  pumpObservationChanges,
  type CanonicalChangeSource,
} from './observation-change-pump'
import type { PendingCandidateSink } from './pending-sink'

const host: Host = {
  id: 'host-1', name: 'devbox', platform: 'linux', arch: 'x64',
  createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-08-28T00:00:00.000Z',
}
const product: AgentProduct = { id: 'claude-code', name: 'Claude Code' }
const installation: AgentInstallation = {
  id: 'installation-1', hostId: host.id, productId: product.id,
  firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-08-28T00:00:00.000Z',
}
const logicalSession: LogicalSession = {
  id: 'logical-1', installationId: installation.id,
  startedAt: '2026-08-28T00:00:00.000Z',
}
const sourceSession: SourceSession = {
  id: 'source-1', sourceId: 'claude', installationId: installation.id,
  nativeSessionId: 'native-1', logicalSessionId: logicalSession.id,
}

function observation(id: string, occurredAt: string, capturedAt: string): CanonicalObservation {
  return {
    id,
    hostId: host.id,
    installationId: installation.id,
    logicalSessionId: logicalSession.id,
    sourceSessionId: sourceSession.id,
    kind: 'message.assistant',
    occurredAt,
    capturedAt,
    payload: { id },
    evidenceRefs: [],
  }
}

const oldEvent = observation(
  'observation-old-event',
  '2025-01-01T00:00:00.000Z',
  '2026-08-28T00:10:00.000Z',
)
const newerEvent = observation(
  'observation-newer-event',
  '2026-08-28T00:05:00.000Z',
  '2026-08-28T00:05:00.000Z',
)

function dependencies(): CanonicalReplicationReader {
  return {
    getHost: async id => id === host.id ? host : null,
    getInstallation: async id => id === installation.id ? installation : null,
    getAgentProduct: async id => id === product.id ? product : null,
    getProject: async () => null,
    getWorkspace: async () => null,
    getRuntimeProfile: async () => null,
    getLogicalSession: async id => id === logicalSession.id ? logicalSession : null,
    getSourceSession: async id => id === sourceSession.id ? sourceSession : null,
    getActor: async () => null,
    getEvidence: async () => null,
    getSourceRecord: async () => null,
  }
}

function sink(seen: string[]): PendingCandidateSink {
  return {
    enqueuePending: async candidate => {
      if (candidate.entityType === 'CanonicalObservation') seen.push(candidate.originEntityId)
      return { created: true, replaced: false }
    },
  }
}

test('bootstrap high-water follows monotonic revision, not occurredAt', async () => {
  const rows = [
    { revision: 10, entityType: 'CanonicalObservation' as const, originEntityId: newerEvent.id, changedAt: '2026-08-28T00:05:01.000Z' },
    // Ingested later but occurred a year earlier. Event-time pagination would risk missing this.
    { revision: 11, entityType: 'CanonicalObservation' as const, originEntityId: oldEvent.id, changedAt: '2026-08-28T00:10:01.000Z' },
  ]
  const changes: CanonicalChangeSource = {
    highWaterRevision: async () => 11,
    scan: async ({ afterRevision = 0, throughRevision, entityType }) => ({
      items: rows.filter(row => row.revision > afterRevision && row.revision <= throughRevision && row.entityType === entityType),
      nextRevision: throughRevision,
      done: true,
    }),
  }
  assert.equal(await captureReplicationHighWater(changes), 11)

  const byId = new Map([[newerEvent.id, newerEvent], [oldEvent.id, oldEvent]])
  const seen: string[] = []
  const result = await pumpObservationChanges({
    changes,
    observations: { get: async id => byId.get(id) ?? null },
    dependencies: dependencies(),
    sink: sink(seen),
    nodeId: 'node-a',
    streamId: 'stream-1',
    generationId: 'generation-1',
    phase: 'bootstrap',
    policy: { mode: 'full', revision: 'policy-1' },
    history: { mode: 'include-existing', revision: 'history-1' },
    throughRevision: 11,
  })

  assert.deepEqual(seen, [newerEvent.id, oldEvent.id])
  assert.equal(result.nextRevision, 11)
  assert.equal(result.done, true)
  assert.equal(result.observationCount, 2)
})

test('bootstrap fixed high-water excludes later revisions for incremental follow-up', async () => {
  const rows = [
    { revision: 20, entityType: 'CanonicalObservation' as const, originEntityId: newerEvent.id, changedAt: '2026-08-28T00:05:01.000Z' },
    { revision: 21, entityType: 'CanonicalObservation' as const, originEntityId: oldEvent.id, changedAt: '2026-08-28T00:10:01.000Z' },
  ]
  const changes: CanonicalChangeSource = {
    highWaterRevision: async () => 21,
    scan: async ({ afterRevision = 0, throughRevision, entityType }) => {
      const items = rows.filter(row => row.revision > afterRevision && row.revision <= throughRevision && row.entityType === entityType)
      return { items, nextRevision: items.at(-1)?.revision ?? afterRevision, done: true }
    },
  }
  const byId = new Map([[newerEvent.id, newerEvent], [oldEvent.id, oldEvent]])
  const seen: string[] = []

  const bootstrap = await pumpObservationChanges({
    changes,
    observations: { get: async id => byId.get(id) ?? null },
    dependencies: dependencies(),
    sink: sink(seen),
    nodeId: 'node-a', streamId: 'stream-1', generationId: 'generation-1', phase: 'bootstrap',
    policy: { mode: 'full', revision: 'policy-1' },
    history: { mode: 'include-existing', revision: 'history-1' },
    throughRevision: 20,
  })
  assert.deepEqual(seen, [newerEvent.id])

  const incremental = await pumpObservationChanges({
    changes,
    observations: { get: async id => byId.get(id) ?? null },
    dependencies: dependencies(),
    sink: sink(seen),
    nodeId: 'node-a', streamId: 'stream-1', generationId: 'generation-1', phase: 'incremental',
    policy: { mode: 'full', revision: 'policy-1' },
    history: { mode: 'include-existing', revision: 'history-1' },
    afterRevision: bootstrap.nextRevision,
    throughRevision: 21,
  })
  assert.equal(incremental.observationCount, 1)
  assert.deepEqual(seen, [newerEvent.id, oldEvent.id])
})

test('duplicate change revisions for one Observation enqueue current state once per page', async () => {
  const changes: CanonicalChangeSource = {
    highWaterRevision: async () => 31,
    scan: async () => ({
      items: [
        { revision: 30, entityType: 'CanonicalObservation', originEntityId: newerEvent.id, changedAt: '2026-08-28T00:00:00.000Z' },
        { revision: 31, entityType: 'CanonicalObservation', originEntityId: newerEvent.id, changedAt: '2026-08-28T00:00:01.000Z' },
      ],
      nextRevision: 31,
      done: true,
    }),
  }
  const seen: string[] = []
  const result = await pumpObservationChanges({
    changes,
    observations: { get: async () => newerEvent },
    dependencies: dependencies(),
    sink: sink(seen),
    nodeId: 'node-a', streamId: 'stream-1', generationId: 'generation-1', phase: 'incremental',
    policy: { mode: 'full', revision: 'policy-1' },
    history: { mode: 'include-existing', revision: 'history-1' },
    throughRevision: 31,
  })
  assert.equal(result.changeCount, 2)
  assert.equal(result.observationCount, 1)
  assert.deepEqual(seen, [newerEvent.id])
})

test('missing Canonical row fails closed until tombstone support exists', async () => {
  const changes: CanonicalChangeSource = {
    highWaterRevision: async () => 1,
    scan: async () => ({
      items: [{ revision: 1, entityType: 'CanonicalObservation', originEntityId: 'missing', changedAt: '2026-08-28T00:00:00.000Z' }],
      nextRevision: 1,
      done: true,
    }),
  }
  await assert.rejects(
    pumpObservationChanges({
      changes,
      observations: { get: async () => null },
      dependencies: dependencies(),
      sink: sink([]),
      nodeId: 'node-a', streamId: 'stream-1', generationId: 'generation-1', phase: 'bootstrap',
      policy: { mode: 'full', revision: 'policy-1' },
      history: { mode: 'include-existing', revision: 'history-1' },
      throughRevision: 1,
    }),
    /Canonical row missing without tombstone/,
  )
})
