import assert from 'node:assert/strict'
import test from 'node:test'
import type { CheckpointRepository } from '@agent-lens/core'
import { CheckpointPiLiveRecoveryStore } from './recovery-store'

function checkpoints(): CheckpointRepository {
  const values = new Map<string, unknown>()
  const key = (scope: string, name: string) => `${scope}:${name}`
  return {
    async get<T>(scope: string, name: string): Promise<T | null> {
      return (values.get(key(scope, name)) as T | undefined) ?? null
    },
    async set<T>(scope: string, name: string, value: T): Promise<void> {
      values.set(key(scope, name), value)
    },
    async clear(scope: string, name: string): Promise<void> {
      values.delete(key(scope, name))
    },
  }
}

test('Pi Live recovery store 只持久化恢复所需输入并可显式删除', async () => {
  const store = new CheckpointPiLiveRecoveryStore(checkpoints())
  await store.put({
    id: 'live-1',
    input: {
      cwd: '/workspace',
      executable: '/tmp/pi',
      provider: 'deepseek',
      model: 'v4',
      name: '任务',
      sessionPath: '/sessions/live.jsonl',
      historyAction: 'continue',
    },
    createdAt: '2026-09-08T00:00:00.000Z',
    updatedAt: '2026-09-08T00:01:00.000Z',
  })

  const [saved] = await store.list()
  assert.equal(saved?.id, 'live-1')
  assert.equal(saved?.input.cwd, '/workspace')
  assert.equal(saved?.input.sessionPath, '/sessions/live.jsonl')
  assert.equal(saved?.input.executable, undefined)

  await store.remove('live-1')
  assert.deepEqual(await store.list(), [])
})
