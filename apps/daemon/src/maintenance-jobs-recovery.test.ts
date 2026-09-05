import assert from 'node:assert/strict'
import test from 'node:test'
import type { MaintenanceJob, MaintenanceJobStore } from '@agent-lens/core'
import { runMaintenanceJob } from './maintenance-jobs'

class MemoryStore implements MaintenanceJobStore {
  job: MaintenanceJob | null = null

  async ensure(input: { id: string; type: any; scope: string; priority: number; progress?: any }) {
    if (!this.job) {
      this.job = {
        id: input.id,
        type: input.type,
        scope: input.scope,
        priority: input.priority,
        state: 'pending',
        revision: 0,
        createdAt: '2026-09-06T00:00:00.000Z',
        updatedAt: '2026-09-06T00:00:00.000Z',
        ...(input.progress === undefined ? {} : { progress: input.progress }),
      }
    }
    return this.job
  }

  async get(id: string) {
    return this.job?.id === id ? this.job : null
  }

  async list() {
    return this.job ? [this.job] : []
  }

  async transition(id: string, revision: number, patch: any) {
    if (!this.job || this.job.id !== id || this.job.revision !== revision) return null
    this.job = {
      ...this.job,
      ...patch,
      revision: revision + 1,
      updatedAt: '2026-09-06T00:00:01.000Z',
    }
    return this.job
  }
}

test('Maintenance Job retries transient Data Runtime failure from latest progress', async () => {
  const store = new MemoryStore()
  const controller = new AbortController()
  let attempts = 0
  const seenInitial: unknown[] = []

  const result = await runMaintenanceJob(
    store,
    {
      id: 'projection:test',
      type: 'projection-rebuild',
      scope: 'test',
      priority: 40,
    },
    controller.signal,
    async context => {
      attempts += 1
      seenInitial.push(context.initialProgress)
      if (attempts === 1) {
        assert.equal(await context.report({ cursor: 'batch-1', scanned: 10 }), true)
        throw new Error('Data Runtime writer worker is unavailable')
      }
      assert.deepEqual(context.initialProgress, { cursor: 'batch-1', scanned: 10 })
      return { cursor: 'done', scanned: 20 }
    },
    value => value,
  )

  assert.equal(attempts, 2)
  assert.equal(result?.status, 'completed')
  assert.deepEqual(result?.job.progress, { cursor: 'done', scanned: 20 })
  assert.equal(store.job?.state, 'completed')
  assert.equal(seenInitial.length, 2)
})

test('Maintenance Job does not retry non-transient failures', async () => {
  const store = new MemoryStore()
  let attempts = 0
  await assert.rejects(runMaintenanceJob(
    store,
    {
      id: 'projection:broken',
      type: 'projection-rebuild',
      scope: 'broken',
      priority: 40,
    },
    new AbortController().signal,
    async () => {
      attempts += 1
      throw new Error('invalid projection data')
    },
  ), /invalid projection data/)
  assert.equal(attempts, 1)
  assert.equal(store.job?.state, 'failed')
})
