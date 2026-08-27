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
import type { CanonicalChangeSource } from './observation-change-pump'
import {
  pumpObservationBootstrapPage,
  type ObservationBootstrapProgress,
  type ObservationBootstrapProgressStore,
} from './observation-bootstrap'
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
  id: 'logical-1', installationId: installation.id, startedAt: '2026-08-28T00:00:00.000Z',
}
const sourceSession: SourceSession = {
  id: 'source-1', sourceId: 'claude', installationId: installation.id,
  nativeSessionId: 'native-1', logicalSessionId: logicalSession.id,
}
const observation: CanonicalObservation = {
  id: 'observation-1', hostId: host.id, installationId: installation.id,
  logicalSessionId: logicalSession.id, sourceSessionId: sourceSession.id,
  kind: 'message.assistant', occurredAt: '2025-01-01T00:00:00.000Z',
  capturedAt: '2026-08-28T00:10:00.000Z', payload: { text: 'hello' }, evidenceRefs: [],
}

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

class MemoryProgress implements ObservationBootstrapProgressStore {
  value: ObservationBootstrapProgress | null = null
  puts: ObservationBootstrapProgress[] = []
  async get(): Promise<ObservationBootstrapProgress | null> { return this.value }
  async put(progress: ObservationBootstrapProgress): Promise<void> {
    this.value = { ...progress }
    this.puts.push({ ...progress })
  }
}

test('bootstrap fixes high-water before work and does not advance revision on failed Pending enqueue', async () => {
  let highWaterCalls = 0
  const changes: CanonicalChangeSource = {
    highWaterRevision: async () => {
      highWaterCalls += 1
      return highWaterCalls === 1 ? 10 : 20
    },
    scan: async ({ afterRevision = 0, throughRevision }) => ({
      items: afterRevision < 10 && throughRevision >= 10
        ? [{ revision: 10, entityType: 'CanonicalObservation', originEntityId: observation.id, changedAt: '2026-08-28T00:10:01.000Z' }]
        : [],
      nextRevision: throughRevision,
      done: true,
    }),
  }
  const progress = new MemoryProgress()
  const failingSink: PendingCandidateSink = {
    enqueuePending: async () => { throw new Error('disk full') },
  }

  await assert.rejects(pumpObservationBootstrapPage({
    changes,
    observations: { get: async () => observation },
    dependencies: dependencies(),
    sink: failingSink,
    progress,
    nodeId: 'node-1', streamId: 'stream-1', generationId: 'gen-1',
    policy: { mode: 'full', revision: 'policy-1' },
    history: { mode: 'include-existing', revision: 'history-1' },
    now: '2026-08-28T00:20:00.000Z',
  }), /disk full/)

  assert.equal(highWaterCalls, 1)
  assert.equal(progress.value?.throughRevision, 10)
  assert.equal(progress.value?.revision, 0)

  const successfulSink: PendingCandidateSink = {
    enqueuePending: async () => ({ created: true, replaced: false }),
  }
  const result = await pumpObservationBootstrapPage({
    changes,
    observations: { get: async () => observation },
    dependencies: dependencies(),
    sink: successfulSink,
    progress,
    nodeId: 'node-1', streamId: 'stream-1', generationId: 'gen-1',
    policy: { mode: 'full', revision: 'policy-1' },
    history: { mode: 'include-existing', revision: 'history-1' },
    now: '2026-08-28T00:21:00.000Z',
  })

  assert.equal(highWaterCalls, 1, 'retry must reuse the fixed bootstrap high-water')
  assert.equal(result.throughRevision, 10)
  assert.equal(progress.value?.revision, 10)
  assert.equal(progress.value?.throughRevision, 10)
})
