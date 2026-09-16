import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanonicalReplicationReader } from './canonical-graph'
import {
  pumpObservationBootstrapGenerationStep,
  type ObservationBootstrapLifecycleState,
  type ObservationBootstrapLifecycleStore,
} from './observation-bootstrap-orchestrator'
import type {
  ObservationSnapshotBootstrapProgress,
  ObservationSnapshotDeltaProgress,
} from './observation-snapshot-bootstrap'

function emptyDependencies(): CanonicalReplicationReader {
  return {
    getHost: async () => null,
    getInstallation: async () => null,
    getAgentProduct: async () => null,
    getProject: async () => null,
    getWorkspace: async () => null,
    getRuntimeProfile: async () => null,
    getLogicalSession: async () => null,
    getSourceSession: async () => null,
    getActor: async () => null,
    getEvidence: async () => null,
    getSourceRecord: async () => null,
  }
}

class MemoryLifecycle implements ObservationBootstrapLifecycleStore {
  state: ObservationBootstrapLifecycleState | null = null

  async get() {
    return this.state
  }

  async ensure(input: {
    streamId: string
    generationId: string
    entityType: 'CanonicalObservation'
    policyRevision: string
    historyRevision: string
    now?: string
  }): Promise<ObservationBootstrapLifecycleState> {
    if (!this.state) {
      this.state = {
        streamId: input.streamId,
        generationId: input.generationId,
        entityType: input.entityType,
        stage: 'staged',
        policyRevision: input.policyRevision,
        historyRevision: input.historyRevision,
        updatedAt: input.now ?? '2026-09-16T00:00:00.000Z',
      }
    }
    return this.state
  }

  async transition(input: {
    streamId: string
    generationId: string
    entityType: 'CanonicalObservation'
    stage: ObservationBootstrapLifecycleState['stage']
    policyRevision: string
    historyRevision: string
    now?: string
  }): Promise<ObservationBootstrapLifecycleState> {
    if (!this.state) throw new Error('lifecycle not initialized')
    this.state = {
      ...this.state,
      stage: input.stage,
      updatedAt: input.now ?? this.state.updatedAt,
    }
    return this.state
  }
}

test('Bootstrap Generation becomes active only after Snapshot, Delta, then Reconciliation', async () => {
  let snapshotProgress: ObservationSnapshotBootstrapProgress | null = null
  let deltaProgress: ObservationSnapshotDeltaProgress | null = null
  let reconciliationCursor: string | undefined
  const captures: number[] = []
  const lifecycle = new MemoryLifecycle()

  const common = {
    changes: {
      highWaterRevision: async () => 0,
      scan: async () => ({ items: [], nextRevision: 0, done: true }),
    },
    snapshot: {
      scan: async () => ({ items: [], done: true }),
    },
    observations: { get: async () => null },
    dependencies: emptyDependencies(),
    pendingSink: {
      enqueuePending: async () => ({ created: true, replaced: false }),
    },
    reconciliationSink: {
      enqueue: async () => ({ created: true, replaced: false }),
      getCursor: async () => reconciliationCursor,
      setCursor: async (_streamId: string, _entityType: string, cursor: string) => {
        reconciliationCursor = cursor
      },
    },
    snapshotProgress: {
      get: async () => snapshotProgress,
      put: async (value: ObservationSnapshotBootstrapProgress) => {
        snapshotProgress = { ...value }
      },
    },
    deltaProgress: {
      get: async () => deltaProgress,
      put: async (value: ObservationSnapshotDeltaProgress) => {
        deltaProgress = { ...value }
      },
    },
    captureProgress: {
      advance: async (input: { capturedRevision: number }) => {
        captures.push(input.capturedRevision)
        return input
      },
    },
    lifecycle,
    nodeId: 'node-1',
    streamId: 'stream-1',
    generationId: 'generation-1',
    policy: { mode: 'full' as const, revision: 'policy-1' },
    history: { mode: 'include-existing' as const, revision: 'history-1' },
  }

  const snapshot = await pumpObservationBootstrapGenerationStep(common)
  assert.equal(snapshot.stage, 'delta')
  assert.equal(snapshot.active, false)
  assert.equal(snapshot.work.kind, 'snapshot')

  const delta = await pumpObservationBootstrapGenerationStep(common)
  assert.equal(delta.stage, 'reconcile')
  assert.equal(delta.active, false)
  assert.equal(delta.work.kind, 'delta')

  const reconciliation = await pumpObservationBootstrapGenerationStep(common)
  assert.equal(reconciliation.stage, 'active')
  assert.equal(reconciliation.active, true)
  assert.equal(reconciliation.work.kind, 'reconcile')

  const active = await pumpObservationBootstrapGenerationStep(common)
  assert.equal(active.stage, 'active')
  assert.equal(active.active, true)
  assert.deepEqual(active.work, { kind: 'none' })
  assert.deepEqual(captures, [0, 0])
})
