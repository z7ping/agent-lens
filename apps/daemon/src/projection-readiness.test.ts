import assert from 'node:assert/strict'
import test from 'node:test'
import type { CheckpointRepository } from '@agent-lens/core'
import {
  beginSessionSummaryProjectionRun,
  markSessionSummaryProjectionClean,
  projectionReadinessInternals,
} from './projection-readiness.js'

function checkpoints(initial?: unknown) {
  const values = new Map<string, unknown>()
  const id = `${projectionReadinessInternals.CHECKPOINT_SCOPE}:${projectionReadinessInternals.CHECKPOINT_KEY}`
  if (initial !== undefined) values.set(id, initial)
  const repository: CheckpointRepository = {
    async get<T>(scope: string, key: string): Promise<T | null> {
      return (values.get(`${scope}:${key}`) as T | undefined) ?? null
    },
    async set<T>(scope: string, key: string, value: T): Promise<void> {
      values.set(`${scope}:${key}`, value)
    },
    async clear(scope: string, key: string): Promise<void> {
      values.delete(`${scope}:${key}`)
    },
  }
  return { repository, values, id }
}

test('clean previous shutdown may reuse a materialized projection and immediately marks this run dirty', async () => {
  const state = checkpoints({ version: 1, clean: true, markedAt: '2026-08-26T00:00:00.000Z' })
  const reusable = await beginSessionSummaryProjectionRun({
    checkpoints: state.repository,
    sessionSummaryProjection: { async isMaterialized() { return true } },
  })
  assert.equal(reusable, true)
  assert.equal(state.values.has(state.id), false)
})

test('unclean previous shutdown forces rebuild', async () => {
  const state = checkpoints()
  const reusable = await beginSessionSummaryProjectionRun({
    checkpoints: state.repository,
    sessionSummaryProjection: { async isMaterialized() { return true } },
  })
  assert.equal(reusable, false)
})

test('clean marker cannot reuse a missing projection', async () => {
  const state = checkpoints({ version: 1, clean: true, markedAt: '2026-08-26T00:00:00.000Z' })
  const reusable = await beginSessionSummaryProjectionRun({
    checkpoints: state.repository,
    sessionSummaryProjection: { async isMaterialized() { return false } },
  })
  assert.equal(reusable, false)
  assert.equal(state.values.has(state.id), false)
})

test('controlled shutdown flushes the projection before writing the clean marker', async () => {
  const state = checkpoints()
  const order: string[] = []
  const originalSet = state.repository.set.bind(state.repository)
  state.repository.set = async <T>(scope: string, key: string, value: T): Promise<void> => {
    order.push('mark')
    await originalSet(scope, key, value)
  }
  await markSessionSummaryProjectionClean(
    { checkpoints: state.repository },
    { async flush() { order.push('flush') } },
  )
  assert.deepEqual(order, ['flush', 'mark'])
  assert.equal((state.values.get(state.id) as { clean: boolean }).clean, true)
})

test('flush failure never writes a clean marker', async () => {
  const state = checkpoints()
  await assert.rejects(() => markSessionSummaryProjectionClean(
    { checkpoints: state.repository },
    { async flush() { throw new Error('flush failed') } },
  ), /flush failed/)
  assert.equal(state.values.has(state.id), false)
})
