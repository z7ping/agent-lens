import assert from 'node:assert/strict'
import test from 'node:test'
import {
  OBSERVATION_ROOT_REPLICATION_ENTITY_TYPES,
  type ReplicationReconciliationSink,
} from '@agent-lens/core/replication'
import type { CanonicalReplicationReader } from './canonical-graph'
import {
  pumpObservationPeriodicReconciliationPage,
  type ObservationPeriodicReconciliationCycle,
  type ObservationPeriodicReconciliationCycleStore,
} from './observation-periodic-reconciliation'
import type {
  ObservationIncrementalProgress,
  ObservationIncrementalProgressStore,
} from './observation-incremental'

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

class MemoryCycles implements ObservationPeriodicReconciliationCycleStore {
  state: ObservationPeriodicReconciliationCycle | null = null

  async beginReconciliationCycle(input: {
    streamId: string
    generationId: string
    entityType: 'CanonicalObservation'
    throughRevision: number
    now?: string
  }) {
    if (this.state?.status === 'running') {
      return { kind: 'running' as const, cycle: this.state }
    }
    const now = input.now ?? '2026-09-16T00:00:00.000Z'
    this.state = {
      streamId: input.streamId,
      generationId: input.generationId,
      entityType: input.entityType,
      cycle: (this.state?.cycle ?? 0) + 1,
      status: 'running',
      throughRevision: input.throughRevision,
      startedAt: now,
      updatedAt: now,
    }
    return { kind: 'running' as const, cycle: this.state }
  }

  async completeReconciliationCycle(input: {
    streamId: string
    generationId: string
    entityType: 'CanonicalObservation'
    nextDueAt: string
    now?: string
  }) {
    if (!this.state) throw new Error('missing cycle')
    const now = input.now ?? '2026-09-16T00:00:00.000Z'
    this.state = {
      ...this.state,
      status: 'idle',
      completedAt: now,
      nextDueAt: input.nextDueAt,
      updatedAt: now,
    }
    return this.state
  }
}

class MemorySink implements ReplicationReconciliationSink {
  cursor: string | undefined

  async enqueue() {
    return { created: true, replaced: false }
  }

  async getCursor() {
    return this.cursor
  }

  async setCursor(_streamId: string, _entityType: string, cursor: string) {
    this.cursor = cursor
  }
}

class MemoryIncrementalProgress implements ObservationIncrementalProgressStore {
  state: ObservationIncrementalProgress | null = {
    streamId: 'stream-1',
    generationId: 'generation-1',
    phase: 'incremental',
    entityType: 'CanonicalObservation',
    revision: 5,
    throughRevision: 5,
    updatedAt: '2026-09-16T00:00:00.000Z',
  }

  async get() {
    return this.state
  }

  async put(progress: ObservationIncrementalProgress) {
    this.state = { ...progress }
  }
}

test('periodic reconciliation fixes one high-water and advances graph capture only after full scan', async () => {
  const cycles = new MemoryCycles()
  const sink = new MemorySink()
  const incrementalProgress = new MemoryIncrementalProgress()
  const captured = new Map<string, number>()
  let highWater = 10
  let scans = 0

  const common = {
    changes: {
      highWaterRevision: async () => highWater,
      scan: async () => ({ items: [], nextRevision: highWater, done: true }),
    },
    snapshot: {
      scan: async ({ afterId }: { afterId?: string }) => {
        scans += 1
        if (!afterId) {
          return { items: [], nextCursor: 'page-1', done: false }
        }
        return { items: [], nextCursor: 'page-1', done: true }
      },
    },
    dependencies: emptyDependencies(),
    sink,
    cycles,
    captureProgress: {
      advance: async (input: { entityType: string; capturedRevision: number }) => {
        captured.set(input.entityType, input.capturedRevision)
        return input
      },
    },
    incrementalProgress,
    nodeId: 'node-1',
    streamId: 'stream-1',
    generationId: 'generation-1',
    policy: { mode: 'full' as const, revision: 'policy-1' },
    history: { mode: 'include-existing' as const, revision: 'history-1' },
    intervalMs: 30 * 60 * 1000,
    now: '2026-09-16T00:00:00.000Z',
  }

  const first = await pumpObservationPeriodicReconciliationPage(common)
  assert.equal(first.kind, 'running')
  assert.equal(captured.size, 0)
  assert.equal(cycles.state?.throughRevision, 10)

  highWater = 20
  const second = await pumpObservationPeriodicReconciliationPage({
    ...common,
    now: '2026-09-16T00:01:00.000Z',
  })
  assert.equal(second.kind, 'completed')
  if (second.kind === 'completed') {
    assert.equal(second.throughRevision, 10)
    assert.equal(second.nextDueAt, '2026-09-16T00:31:00.000Z')
  }
  assert.equal(scans, 2)
  assert.deepEqual(
    [...captured.keys()].sort(),
    [...OBSERVATION_ROOT_REPLICATION_ENTITY_TYPES].sort(),
  )
  assert.ok([...captured.values()].every(revision => revision === 10))
  assert.equal(incrementalProgress.state?.revision, 10)
  assert.equal(incrementalProgress.state?.throughRevision, 10)
})
