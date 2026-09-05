import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'

test('checkpoint CAS rejects stale completion after concurrent dirty update', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const checkpoints = storage.checkpoints
    const scope = 'parser-replay'
    const key = 'codex:install:20:all'
    const running = {
      sourceId: 'codex',
      installationId: 'install',
      targetParserVersion: '20',
      window: 'all',
      state: 'running',
      dirty: false,
      updatedAt: '2026-09-06T00:00:00.000Z',
    }
    assert.equal(await checkpoints.compareAndSet(scope, key, null, running), true)
    const beforeDirty = await checkpoints.getWithRevision<typeof running>(scope, key)
    assert.ok(beforeDirty)

    storage.db.prepare(`
      UPDATE source_checkpoints
      SET value_json = json_set(value_json, '$.state', 'pending', '$.dirty', json('true'))
      WHERE scope = ? AND checkpoint_key = ?
    `).run(scope, key)

    const afterDirty = await checkpoints.getWithRevision<typeof running>(scope, key)
    assert.ok(afterDirty)
    assert.ok(afterDirty.revision > beforeDirty.revision)
    assert.equal((afterDirty.value as any).dirty, true)
    assert.equal((afterDirty.value as any).state, 'pending')

    const staleCompleted = {
      ...running,
      state: 'completed',
      completedAt: '2026-09-06T00:01:00.000Z',
      updatedAt: '2026-09-06T00:01:00.000Z',
    }
    assert.equal(
      await checkpoints.compareAndSet(scope, key, beforeDirty.revision, staleCompleted),
      false,
    )

    const final = await checkpoints.getWithRevision<any>(scope, key)
    assert.equal(final?.value.dirty, true)
    assert.equal(final?.value.state, 'pending')
  } finally {
    await storage.close()
  }
})

test('checkpoint CAS allows exactly one writer for the same revision', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const checkpoints = storage.checkpoints
    assert.equal(await checkpoints.compareAndSet('scope', 'key', null, { value: 1 }), true)
    const current = await checkpoints.getWithRevision<{ value: number }>('scope', 'key')
    assert.ok(current)

    assert.equal(
      await checkpoints.compareAndSet('scope', 'key', current.revision, { value: 2 }),
      true,
    )
    assert.equal(
      await checkpoints.compareAndSet('scope', 'key', current.revision, { value: 3 }),
      false,
    )
    assert.deepEqual(await checkpoints.get('scope', 'key'), { value: 2 })
  } finally {
    await storage.close()
  }
})
