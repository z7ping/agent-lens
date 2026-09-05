import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { SqliteExecutor } from './executor'

test('SQLite executor exposes queue wait, execution and queue depth metrics', async () => {
  const db = new Database(':memory:')
  const executor = new SqliteExecutor(db)
  let release!: () => void
  const blocker = new Promise<void>(resolve => { release = resolve })

  const first = executor.run(async () => {
    await blocker
    return 1
  })
  const second = executor.run(() => 2)
  await new Promise<void>(resolve => setImmediate(resolve))

  const queued = executor.metrics()
  assert.equal(queued.enqueued, 2)
  assert.equal(queued.active, 1)
  assert.equal(queued.queueDepth, 1)
  assert.ok(queued.maxQueueDepth >= 2)

  release()
  assert.deepEqual(await Promise.all([first, second]), [1, 2])

  const done = executor.metrics()
  assert.equal(done.completed, 2)
  assert.equal(done.active, 0)
  assert.equal(done.queueDepth, 0)
  assert.ok(done.queueWaitMs.max >= 0)
  assert.ok(done.executionMs.max >= 0)
  assert.ok(done.queueWaitMs.p95 >= 0)
  await executor.close()
})

test('SQLite executor records transaction duration separately', async () => {
  const db = new Database(':memory:')
  const executor = new SqliteExecutor(db)
  db.exec('CREATE TABLE sample(id INTEGER PRIMARY KEY)')

  await executor.transaction(async () => {
    await executor.run(() => db.prepare('INSERT INTO sample(id) VALUES (1)').run())
  })

  const metrics = executor.metrics()
  assert.equal(metrics.transactionMs.count, 1)
  assert.ok(metrics.transactionMs.max >= 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sample').get().count, 1)
  await executor.close()
})
