import assert from 'node:assert/strict'
import test from 'node:test'
import { createOriginEntityRef, replicaKeyFor, sharedGroupKeyFor } from '@agent-lens/core/replication'
import { SqliteHubRemoteReadRepository } from './hub-remote-reader'
import { SqliteHubReplicaStore } from './hub-replica-store'
import { SqliteStorageService } from './storage'

test('H8 remote read exposes active generation only and preserves availability body', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()
    const store = new SqliteHubReplicaStore(storage.executor)
    const reader = new SqliteHubRemoteReadRepository(storage.executor)
    const publicId = replicaKeyFor(createOriginEntityRef('node-a', 'LogicalSession', 'session-1'))

    await store.putGeneration({
      originNodeId: 'node-a',
      generationId: 'gen-1',
      status: 'staged',
      createdAt: '2026-08-28T00:00:00.000Z',
    })
    await store.putEntity({
      originNodeId: 'node-a',
      generationId: 'gen-1',
      entityType: 'LogicalSession',
      originEntityId: 'session-1',
      replicaKey: publicId,
      scope: 'node',
      entityVersion: 1,
      contentHash: 'hash-g1',
      body: {
        title: { state: 'value', value: 'old-title' },
        workspacePath: { state: 'omitted', reason: 'policy' },
      },
      updatedSequence: 1,
      updatedAt: '2026-08-28T00:01:00.000Z',
    })
    await store.activateGeneration('node-a', 'gen-1', '2026-08-28T00:02:00.000Z')

    await store.putGeneration({
      originNodeId: 'node-a',
      generationId: 'gen-2',
      status: 'staged',
      createdAt: '2026-08-28T00:03:00.000Z',
    })
    await store.putEntity({
      originNodeId: 'node-a',
      generationId: 'gen-2',
      entityType: 'LogicalSession',
      originEntityId: 'session-1',
      replicaKey: publicId,
      scope: 'node',
      entityVersion: 1,
      contentHash: 'hash-g2',
      body: {
        title: { state: 'value', value: 'new-title' },
        workspacePath: { state: 'omitted', reason: 'history-boundary' },
      },
      updatedSequence: 1,
      updatedAt: '2026-08-28T00:04:00.000Z',
    })

    const before = await reader.get(publicId)
    assert.equal(before?.generationId, 'gen-1')
    assert.deepEqual(before?.body, {
      title: { state: 'value', value: 'old-title' },
      workspacePath: { state: 'omitted', reason: 'policy' },
    })
    assert.deepEqual((await reader.list({ originNodeId: 'node-a', entityType: 'LogicalSession' })).map(item => item.generationId), ['gen-1'])

    await store.activateGeneration('node-a', 'gen-2', '2026-08-28T00:05:00.000Z')

    const after = await reader.get(publicId)
    assert.equal(after?.generationId, 'gen-2')
    assert.deepEqual(after?.body, {
      title: { state: 'value', value: 'new-title' },
      workspacePath: { state: 'omitted', reason: 'history-boundary' },
    })
    assert.equal((await store.getGeneration('node-a', 'gen-1'))?.status, 'retired')
  } finally {
    await storage.close()
  }
})

test('H8 remote read exposes Hub-recomputed shared identity instead of stored Node assertion JSON', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()
    const store = new SqliteHubReplicaStore(storage.executor)
    const reader = new SqliteHubRemoteReadRepository(storage.executor)
    const publicId = replicaKeyFor(createOriginEntityRef('node-a', 'Project', 'project-1'))
    const portable = {
      algorithm: 'project-repository-v1' as const,
      normalized: 'https://github.com/z7ping/agent-lens',
    }
    const sharedKey = sharedGroupKeyFor('Project', portable)

    await store.putGeneration({
      originNodeId: 'node-a',
      generationId: 'gen-1',
      status: 'staged',
      createdAt: '2026-08-28T00:00:00.000Z',
    })
    await store.putEntity({
      originNodeId: 'node-a',
      generationId: 'gen-1',
      entityType: 'Project',
      originEntityId: 'project-1',
      replicaKey: publicId,
      scope: 'node',
      entityVersion: 1,
      contentHash: 'hash-project',
      body: { name: { state: 'value', value: 'AgentLens' } },
      sharedIdentity: {
        identityAlgorithm: 'node-claimed-value',
        normalizedPortableIdentity: 'node-claimed-value',
        claimedSharedKey: 'node-claimed-value',
      },
      updatedSequence: 1,
      updatedAt: '2026-08-28T00:01:00.000Z',
    })
    await store.putSharedIdentity({
      originNodeId: 'node-a',
      generationId: 'gen-1',
      entityType: 'Project',
      originEntityId: 'project-1',
      stateKind: 'conditional-membership',
      identityAlgorithm: portable.algorithm,
      normalizedIdentity: portable.normalized,
      sharedKey,
      updatedSequence: 1,
      updatedAt: '2026-08-28T00:01:00.000Z',
    })
    await store.activateGeneration('node-a', 'gen-1', '2026-08-28T00:02:00.000Z')

    const item = await reader.get(publicId)
    assert.deepEqual(item?.sharedIdentity, {
      stateKind: 'conditional-membership',
      identityAlgorithm: portable.algorithm,
      normalizedIdentity: portable.normalized,
      sharedKey,
    })
    assert.deepEqual((await reader.list({ sharedKey })).map(entry => entry.publicId), [publicId])
  } finally {
    await storage.close()
  }
})
