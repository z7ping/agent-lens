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
  pumpObservationSnapshotBootstrapPage,
  type CanonicalObservationSnapshotSource,
  type ObservationSnapshotBootstrapProgress,
  type ObservationSnapshotBootstrapProgressStore,
} from './observation-snapshot-bootstrap'
import type { PendingCandidateSink } from './pending-sink'

const host: Host = {
  id: 'host-1',
  name: 'devbox',
  platform: 'linux',
  arch: 'x64',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-09-16T00:00:00.000Z',
}
const product: AgentProduct = { id: 'codex', name: 'Codex' }
const installation: AgentInstallation = {
  id: 'installation-1',
  hostId: host.id,
  productId: product.id,
  firstSeenAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-09-16T00:00:00.000Z',
}
const logicalSession: LogicalSession = {
  id: 'logical-1',
  installationId: installation.id,
  startedAt: '2026-09-16T00:00:00.000Z',
}
const sourceSession: SourceSession = {
  id: 'source-session-1',
  sourceId: 'codex',
  installationId: installation.id,
  nativeSessionId: 'native-1',
  logicalSessionId: logicalSession.id,
}
const observation: CanonicalObservation = {
  id: 'observation-1',
  hostId: host.id,
  installationId: installation.id,
  logicalSessionId: logicalSession.id,
  sourceSessionId: sourceSession.id,
  kind: 'message.assistant',
  capturedAt: '2026-09-16T00:10:00.000Z',
  payload: { text: 'hello' },
  evidenceRefs: [],
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

class MemoryProgress implements ObservationSnapshotBootstrapProgressStore {
  value: ObservationSnapshotBootstrapProgress | null = null
  puts: ObservationSnapshotBootstrapProgress[] = []
  events: string[] = []

  async get(): Promise<ObservationSnapshotBootstrapProgress | null> {
    return this.value
  }

  async put(progress: ObservationSnapshotBootstrapProgress): Promise<void> {
    this.events.push(`progress:${progress.snapshotComplete ? 'complete' : progress.cursor ?? 'baseline'}`)
    this.value = { ...progress }
    this.puts.push({ ...progress })
  }
}

test('Snapshot Bootstrap 先持久 baseline，Pending 失败时不推进 cursor，重试复用同一 baseline', async () => {
  let highWaterCalls = 0
  let scanCalls = 0
  const progress = new MemoryProgress()
  const snapshot: CanonicalObservationSnapshotSource = {
    scan: async input => {
      progress.events.push('scan')
      scanCalls += 1
      assert.equal(input.afterId, undefined)
      return {
        items: [observation],
        nextCursor: observation.id,
        done: true,
      }
    },
  }
  const changes = {
    highWaterRevision: async () => {
      highWaterCalls += 1
      return highWaterCalls === 1 ? 42 : 99
    },
  }

  const failingSink: PendingCandidateSink = {
    enqueuePending: async () => {
      throw new Error('disk full')
    },
  }
  await assert.rejects(
    pumpObservationSnapshotBootstrapPage({
      changes,
      snapshot,
      dependencies: dependencies(),
      sink: failingSink,
      progress,
      nodeId: 'node-1',
      streamId: 'stream-1',
      generationId: 'generation-1',
      policy: { mode: 'full', revision: 'policy-1' },
      history: { mode: 'include-existing', revision: 'history-1' },
      now: '2026-09-16T00:20:00.000Z',
    }),
    /disk full/,
  )

  assert.equal(progress.events[0], 'progress:baseline')
  assert.equal(progress.events[1], 'scan')
  assert.equal(progress.value?.baselineRevision, 42)
  assert.equal(progress.value?.cursor, undefined)
  assert.equal(progress.value?.snapshotComplete, false)

  const successfulSink: PendingCandidateSink = {
    enqueuePending: async () => ({ created: true, replaced: false }),
  }
  const result = await pumpObservationSnapshotBootstrapPage({
    changes,
    snapshot,
    dependencies: dependencies(),
    sink: successfulSink,
    progress,
    nodeId: 'node-1',
    streamId: 'stream-1',
    generationId: 'generation-1',
    policy: { mode: 'full', revision: 'policy-1' },
    history: { mode: 'include-existing', revision: 'history-1' },
    now: '2026-09-16T00:21:00.000Z',
  })

  assert.equal(highWaterCalls, 1)
  assert.equal(scanCalls, 2)
  assert.equal(result.baselineRevision, 42)
  assert.equal(result.nextCursor, observation.id)
  assert.equal(result.done, true)
  assert.equal(progress.value?.cursor, observation.id)
  assert.equal(progress.value?.snapshotComplete, true)

  const completed = await pumpObservationSnapshotBootstrapPage({
    changes,
    snapshot,
    dependencies: dependencies(),
    sink: successfulSink,
    progress,
    nodeId: 'node-1',
    streamId: 'stream-1',
    generationId: 'generation-1',
    policy: { mode: 'full', revision: 'policy-1' },
    history: { mode: 'include-existing', revision: 'history-1' },
  })
  assert.equal(completed.done, true)
  assert.equal(completed.observationCount, 0)
  assert.equal(scanCalls, 2)
})

test('from-now Snapshot Bootstrap 把 History Boundary 下推给 Root scanner', async () => {
  const progress = new MemoryProgress()
  let filter: string | undefined
  const snapshot: CanonicalObservationSnapshotSource = {
    scan: async input => {
      filter = input.capturedAtOnOrAfter
      return { items: [], done: true }
    },
  }

  const result = await pumpObservationSnapshotBootstrapPage({
    changes: { highWaterRevision: async () => 7 },
    snapshot,
    dependencies: dependencies(),
    sink: { enqueuePending: async () => ({ created: true, replaced: false }) },
    progress,
    nodeId: 'node-1',
    streamId: 'stream-1',
    generationId: 'generation-1',
    policy: { mode: 'metadata-only', revision: 'policy-1' },
    history: {
      mode: 'from-now',
      revision: 'history-1',
      boundaryCapturedAt: '2026-09-16T00:00:00.000Z',
    },
  })

  assert.equal(filter, '2026-09-16T00:00:00.000Z')
  assert.equal(result.baselineRevision, 7)
  assert.equal(result.done, true)
  assert.equal(progress.value?.snapshotComplete, true)
})

test('from-now Snapshot Bootstrap 缺少有效 boundary 时拒绝扫描', async () => {
  const progress = new MemoryProgress()
  let scanned = false
  await assert.rejects(
    pumpObservationSnapshotBootstrapPage({
      changes: { highWaterRevision: async () => 3 },
      snapshot: {
        scan: async () => {
          scanned = true
          return { items: [], done: true }
        },
      },
      dependencies: dependencies(),
      sink: { enqueuePending: async () => ({ created: true, replaced: false }) },
      progress,
      nodeId: 'node-1',
      streamId: 'stream-1',
      generationId: 'generation-1',
      policy: { mode: 'full', revision: 'policy-1' },
      history: { mode: 'from-now', revision: 'history-1' },
    }),
    /boundaryCapturedAt/,
  )
  assert.equal(scanned, false)
  assert.equal(progress.value?.baselineRevision, 3)
})
