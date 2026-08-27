import assert from 'node:assert/strict'
import test from 'node:test'
import {
  replicaKeyFor,
  createOriginEntityRef,
  sharedGroupKeyFor,
  sharedRootKeyFor,
} from '@agent-lens/core/replication'
import {
  REPLICATION_PROTOCOL,
  computeBatchContentHash,
  computeEntityContentHash,
  type ReplicationBatch,
  type WireEntityEnvelope,
} from '@agent-lens/protocol/replication'
import { SqliteHubReplicaStore, SqliteStorageService } from '../../storage-sqlite/src/index'
import { activateReplicaGeneration, importReplicationBatch } from './hub-importer'

function entity(input: Omit<WireEntityEnvelope, 'contentHash'>): WireEntityEnvelope {
  return { ...input, contentHash: computeEntityContentHash(input) }
}

function batch(input: Omit<ReplicationBatch, 'contentHash'>): ReplicationBatch {
  return { ...input, contentHash: computeBatchContentHash(input) }
}

function baseBatch(sequence: number, entities: readonly WireEntityEnvelope[]): ReplicationBatch {
  return batch({
    protocol: REPLICATION_PROTOCOL,
    nodeId: 'node-a',
    hubId: 'hub-1',
    streamId: 'stream-a',
    generationId: 'gen-a',
    sequence,
    batchId: `batch-${sequence}`,
    phase: sequence === 1 ? 'bootstrap' : 'incremental',
    policyRevision: 'policy-1',
    historyRevision: 'history-1',
    entities,
    identityPromotions: [],
  })
}

function product(): WireEntityEnvelope {
  return entity({
    entityType: 'AgentProduct',
    scope: 'shared',
    originEntityId: 'codex',
    entityVersion: 1,
    body: { name: 'Codex' },
  })
}

function installation(id = 'install-1'): WireEntityEnvelope {
  const origin = createOriginEntityRef('node-a', 'AgentInstallation', id)
  return entity({
    entityType: 'AgentInstallation',
    scope: 'node',
    originEntityId: id,
    entityVersion: 1,
    body: { version: '1.0.0' },
    references: {
      product: {
        kind: 'shared',
        entityType: 'AgentProduct',
        sharedKey: sharedRootKeyFor('AgentProduct', 'codex'),
      },
    },
    replicaKey: replicaKeyFor(origin),
  })
}

test('H7 imports one R1 batch atomically into staged Remote Replica state and exact retry is idempotent', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()
    const store = new SqliteHubReplicaStore(storage.executor)
    const first = baseBatch(1, [product(), installation()])

    assert.deepEqual(await importReplicationBatch({
      store,
      batch: first,
      now: '2026-08-28T00:00:00.000Z',
    }), { status: 'committed', ackSequence: 1 })

    assert.equal((await store.getStream('stream-a'))?.ackSequence, 1)
    assert.equal((await store.getGeneration('node-a', 'gen-a'))?.status, 'staged')
    assert.equal((await store.getEntity({
      originNodeId: 'node-a',
      generationId: 'gen-a',
      entityType: 'AgentInstallation',
      originEntityId: 'install-1',
    }))?.replicaKey, replicaKeyFor(createOriginEntityRef('node-a', 'AgentInstallation', 'install-1')))
    assert.equal(await store.hasSharedIdentityKey({
      originNodeId: 'node-a',
      generationId: 'gen-a',
      entityType: 'AgentProduct',
      sharedKey: sharedRootKeyFor('AgentProduct', 'codex'),
    }), true)
    assert.equal((await store.getCommittedBatch('stream-a', 1))?.contentHash, first.contentHash)

    assert.deepEqual(await importReplicationBatch({
      store,
      batch: first,
      now: '2026-08-28T00:01:00.000Z',
    }), { status: 'exact-retry', ackSequence: 1 })

    await activateReplicaGeneration({
      store,
      originNodeId: 'node-a',
      generationId: 'gen-a',
      now: '2026-08-28T00:02:00.000Z',
    })
    assert.equal((await store.getGeneration('node-a', 'gen-a'))?.status, 'active')
  } finally {
    await storage.close()
  }
})

test('H7 rolls back entities, shared identity, committed batch and ACK when one entity fails Hub recomputation', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()
    const store = new SqliteHubReplicaStore(storage.executor)
    await importReplicationBatch({ store, batch: baseBatch(1, [product(), installation()]) })

    const host = entity({
      entityType: 'Host',
      scope: 'node',
      originEntityId: 'host-rollback',
      entityVersion: 1,
      body: { name: 'rollback' },
      replicaKey: replicaKeyFor(createOriginEntityRef('node-a', 'Host', 'host-rollback')),
    })
    const projectIdentity = { algorithm: 'project-repository-v1' as const, normalized: 'https://github.com/z7ping/agent-lens' }
    const project = entity({
      entityType: 'Project',
      scope: 'node',
      originEntityId: 'project-bad',
      entityVersion: 1,
      body: { name: 'bad' },
      replicaKey: replicaKeyFor(createOriginEntityRef('node-a', 'Project', 'project-bad')),
      sharedIdentity: {
        identityAlgorithm: projectIdentity.algorithm,
        normalizedPortableIdentity: projectIdentity.normalized,
        claimedSharedKey: `${sharedGroupKeyFor('Project', projectIdentity)}-tampered`,
      },
    })
    const second = baseBatch(2, [host, project])

    await assert.rejects(importReplicationBatch({ store, batch: second }), /shared key mismatch/)

    assert.equal((await store.getStream('stream-a'))?.ackSequence, 1)
    assert.equal(await store.hasEntity({
      originNodeId: 'node-a',
      generationId: 'gen-a',
      entityType: 'Host',
      originEntityId: 'host-rollback',
    }), false)
    assert.equal(await store.getCommittedBatch('stream-a', 2), undefined)
    assert.equal(await store.hasSharedIdentityKey({
      originNodeId: 'node-a',
      generationId: 'gen-a',
      entityType: 'Project',
      sharedKey: sharedGroupKeyFor('Project', projectIdentity),
    }), false)
  } finally {
    await storage.close()
  }
})

test('H7 rejects sequence gaps without leaving an empty stream or any Remote Replica state', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()
    const store = new SqliteHubReplicaStore(storage.executor)
    await assert.rejects(
      importReplicationBatch({ store, batch: baseBatch(2, [product()]) }),
      (error: any) => error?.code === 'SEQUENCE_GAP',
    )
    assert.equal(await store.getStream('stream-a'), undefined)
    assert.equal(await store.getGeneration('node-a', 'gen-a'), undefined)
    assert.equal(await store.getCommittedBatch('stream-a', 2), undefined)
  } finally {
    await storage.close()
  }
})

test('H7 atomically retires G1 only when staged G2 is explicitly activated', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()
    const store = new SqliteHubReplicaStore(storage.executor)
    await store.putGeneration({
      originNodeId: 'node-a',
      generationId: 'gen-1',
      status: 'staged',
      createdAt: '2026-08-28T00:00:00.000Z',
    })
    await activateReplicaGeneration({
      store,
      originNodeId: 'node-a',
      generationId: 'gen-1',
      now: '2026-08-28T00:01:00.000Z',
    })
    await store.putGeneration({
      originNodeId: 'node-a',
      generationId: 'gen-2',
      status: 'staged',
      createdAt: '2026-08-28T00:02:00.000Z',
    })

    assert.equal((await store.getGeneration('node-a', 'gen-1'))?.status, 'active')
    assert.equal((await store.getGeneration('node-a', 'gen-2'))?.status, 'staged')

    await activateReplicaGeneration({
      store,
      originNodeId: 'node-a',
      generationId: 'gen-2',
      now: '2026-08-28T00:03:00.000Z',
    })

    const first = await store.getGeneration('node-a', 'gen-1')
    const second = await store.getGeneration('node-a', 'gen-2')
    assert.equal(first?.status, 'retired')
    assert.equal(first?.retiredAt, '2026-08-28T00:03:00.000Z')
    assert.equal(second?.status, 'active')
    assert.equal(second?.activatedAt, '2026-08-28T00:03:00.000Z')
  } finally {
    await storage.close()
  }
})
