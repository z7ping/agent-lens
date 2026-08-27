import assert from 'node:assert/strict'
import test from 'node:test'
import {
  reconcileReplicationPage,
  type ReplicationReconciliationSource,
} from '@agent-lens/core/replication'
import { SqliteReplicationReconciliationSink } from './replication-reconciliation'
import { SqliteStorageService } from './storage'

const source: ReplicationReconciliationSource = {
  async scan({ entityType, cursor }) {
    assert.equal(entityType, 'LogicalSession')
    assert.equal(cursor, undefined)
    return {
      items: [
        {
          id: 'reconcile-session-1',
          dedupKey: 'LogicalSession:session-1',
          entityType: 'LogicalSession',
          originEntityId: 'session-1',
          candidateHash: 'candidate-1',
          payload: { id: 'session-1', title: 'Recovered by reconciliation' },
        },
      ],
      nextCursor: 'cursor-1',
      done: true,
    }
  },
}

test('reconciliation repairs a missed fast-path enqueue and persists its cursor', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()
    await storage.replication.ensureStream({
      relationshipId: 'rel-1',
      hubId: 'hub-1',
      streamId: 'stream-1',
      generationId: 'gen-1',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
    })

    assert.deepEqual(await storage.replication.listPending('stream-1'), [])

    const sink = new SqliteReplicationReconciliationSink(storage.replication)
    const result = await reconcileReplicationPage({
      source,
      sink,
      streamId: 'stream-1',
      generationId: 'gen-1',
      entityType: 'LogicalSession',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
    })

    assert.deepEqual(result, {
      scanned: 1,
      created: 1,
      replaced: 0,
      unchanged: 0,
      nextCursor: 'cursor-1',
      done: true,
    })
    const pending = await storage.replication.listPending('stream-1')
    assert.equal(pending.length, 1)
    assert.equal(pending[0]?.phase, 'reconcile')
    assert.equal(pending[0]?.candidateHash, 'candidate-1')
    assert.deepEqual(pending[0]?.payload, { id: 'session-1', title: 'Recovered by reconciliation' })
    assert.equal((await storage.replication.getReconciliationCursor('stream-1', 'LogicalSession'))?.cursor, 'cursor-1')
  } finally {
    storage.close()
  }
})
