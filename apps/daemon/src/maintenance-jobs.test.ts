import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  MaintenanceJob,
  MaintenanceJobEnsureInput,
  MaintenanceJobState,
  MaintenanceJobStore,
  MaintenanceJobTransitionInput,
} from '@agent-lens/core'
import { runMaintenanceJob } from './maintenance-jobs'

class MemoryJobStore implements MaintenanceJobStore {
  job: MaintenanceJob | null = null

  async ensure(input: MaintenanceJobEnsureInput): Promise<MaintenanceJob> {
    if (!this.job) {
      const now = new Date().toISOString()
      this.job = {
        ...input,
        state: 'pending',
        revision: 0,
        createdAt: now,
        updatedAt: now,
      }
    }
    return this.job
  }

  async get(id: string): Promise<MaintenanceJob | null> {
    return this.job?.id === id ? this.job : null
  }

  async list(states?: readonly MaintenanceJobState[]): Promise<MaintenanceJob[]> {
    if (!this.job || (states?.length && !states.includes(this.job.state))) return []
    return [this.job]
  }

  async transition(
    id: string,
    expectedRevision: number,
    input: MaintenanceJobTransitionInput,
  ): Promise<MaintenanceJob | null> {
    if (!this.job || this.job.id !== id || this.job.revision !== expectedRevision) return null
    const now = new Date().toISOString()
    this.job = {
      ...this.job,
      ...input,
      revision: this.job.revision + 1,
      updatedAt: now,
      ...(input.state === 'running' ? { startedAt: this.job.startedAt ?? now } : {}),
      ...(input.state === 'completed' ? { completedAt: now } : {}),
    }
    return this.job
  }
}

test('Maintenance Job runner persists running progress then completes', async () => {
  const store = new MemoryJobStore()
  const controller = new AbortController()
  const result = await runMaintenanceJob(
    store,
    { id: 'replay', type: 'parser-replay', scope: 'all', priority: 50 },
    controller.signal,
    async context => {
      assert.equal(await context.report({ records: 10 }), true)
      return { records: 20 }
    },
    value => value,
  )

  assert.equal(result?.status, 'completed')
  assert.equal(store.job?.state, 'completed')
  assert.deepEqual(store.job?.progress, { records: 20 })
  assert.ok((store.job?.revision ?? 0) >= 3)
})

test('Maintenance Job runner marks failures and preserves error summary', async () => {
  const store = new MemoryJobStore()
  const controller = new AbortController()
  await assert.rejects(
    runMaintenanceJob(
      store,
      { id: 'compression', type: 'source-record-compression', scope: 'legacy', priority: 60 },
      controller.signal,
      async () => { throw new Error('compression failed') },
    ),
    /compression failed/,
  )
  assert.equal(store.job?.state, 'failed')
  assert.match(store.job?.errorSummary ?? '', /compression failed/)
})

test('Maintenance Job runner pauses before work when already aborted', async () => {
  const store = new MemoryJobStore()
  const controller = new AbortController()
  controller.abort()
  let executed = false
  const result = await runMaintenanceJob(
    store,
    { id: 'projection', type: 'projection-rebuild', scope: 'session', priority: 40 },
    controller.signal,
    async () => { executed = true },
  )
  assert.equal(executed, false)
  assert.equal(result?.status, 'paused')
  assert.equal(store.job?.state, 'paused')
})
