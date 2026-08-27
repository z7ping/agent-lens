import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'

test('one relationship can retain an old stream and create a rollover stream', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()
    await storage.replication.ensureStream({
      relationshipId: 'rel-1',
      hubId: 'hub-1',
      streamId: 'stream-old',
      generationId: 'gen-old',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      status: 'rollover-required',
    })
    await storage.replication.ensureStream({
      relationshipId: 'rel-1',
      hubId: 'hub-1',
      streamId: 'stream-new',
      generationId: 'gen-new',
      policyRevision: 'policy-2',
      historyRevision: 'history-1',
    })

    assert.equal((await storage.replication.getStream('stream-old'))?.status, 'rollover-required')
    assert.equal((await storage.replication.getStream('stream-new'))?.status, 'active')
  } finally {
    storage.close()
  }
})
