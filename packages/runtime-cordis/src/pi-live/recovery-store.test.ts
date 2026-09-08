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

test('Pi Live recovery store 只持久化可继续的原生 Session 身份并可显式删除', async () => {
  const repository = checkpoints()
  const store = new CheckpointPiLiveRecoveryStore(repository)
  await store.put({
    id: 'live-1',
    input: {
      cwd: '/workspace',
      executable: '/tmp/pi',
      provider: 'deepseek',
      model: 'v4',
      name: '任务',
      sessionPath: '/sessions/live.jsonl',
      historyAction: 'fork',
    },
    createdAt: '2026-09-08T00:00:00.000Z',
    updatedAt: '2026-09-08T00:01:00.000Z',
  })

  const [saved] = await store.list()
  assert.equal(saved?.id, 'live-1')
  assert.equal(saved?.input.cwd, '/workspace')
  assert.equal(saved?.input.sessionPath, '/sessions/live.jsonl')
  assert.equal(saved?.input.historyAction, 'continue')
  assert.equal(saved?.input.executable, undefined)
  assert.equal(saved?.input.provider, undefined)
  assert.equal(saved?.input.model, undefined)

  await store.remove('live-1')
  assert.deepEqual(await store.list(), [])
})

test('Pi Live recovery store 拒绝没有原生 Session 路径的伪恢复记录', async () => {
  const store = new CheckpointPiLiveRecoveryStore(checkpoints())
  assert.throws(
    () => store.put({
      id: 'live-without-session',
      input: { cwd: '/workspace', name: '尚未解析 Session' },
      createdAt: '2026-09-08T00:00:00.000Z',
      updatedAt: '2026-09-08T00:00:01.000Z',
    }),
    /native session path/i,
  )
})

test('Pi Live recovery store 读取时忽略旧的无 sessionPath 记录，避免 URL 恢复时误建新 Session', async () => {
  const repository = checkpoints()
  await repository.set('pi-live', 'recoverable-runtimes-v1', {
    version: 1,
    runtimes: [{
      id: 'legacy-live',
      input: { cwd: '/workspace', provider: 'deepseek', model: 'v4' },
      createdAt: '2026-09-08T00:00:00.000Z',
      updatedAt: '2026-09-08T00:01:00.000Z',
    }],
  })

  const store = new CheckpointPiLiveRecoveryStore(repository)
  assert.deepEqual(await store.list(), [])
})
