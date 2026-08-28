import assert from 'node:assert/strict'
import test from 'node:test'
import { createOriginEntityRef, replicaKeyFor } from '@agent-lens/core/replication'
import { SqliteHubRemoteReadRepository } from './hub-remote-reader'
import { SqliteHubReplicaStore } from './hub-replica-store'
import { HubUnifiedLogicalSessionReader } from './hub-unified-reader'
import { SqliteStorageService } from './storage'

async function putLocalSession(storage: SqliteStorageService) {
  await storage.repositories.hosts.put({
    id: 'host-local', name: 'hub-local', platform: 'linux', arch: 'x64',
    createdAt: '2026-08-28T00:00:00.000Z', lastSeenAt: '2026-08-28T00:00:00.000Z',
  })
  await storage.repositories.installations.putProduct({ id: 'codex', name: 'Codex' })
  await storage.repositories.installations.put({
    id: 'install-local', hostId: 'host-local', productId: 'codex',
    firstSeenAt: '2026-08-28T00:00:00.000Z', lastSeenAt: '2026-08-28T00:00:00.000Z',
  })
  await storage.repositories.sessions.putLogicalSession({
    id: 'local-session', installationId: 'install-local', title: '本机会话',
    startedAt: '2026-08-28T00:01:00.000Z', endedAt: '2026-08-28T00:02:00.000Z',
  })
  await storage.repositories.sessions.putSourceSession({
    id: 'source-local', sourceId: 'codex', installationId: 'install-local',
    nativeSessionId: 'local-native', logicalSessionId: 'local-session',
  })
  await storage.repositories.observations.put({
    id: 'local-observation', hostId: 'host-local', installationId: 'install-local',
    logicalSessionId: 'local-session', sourceSessionId: 'source-local', kind: 'message.user',
    occurredAt: '2026-08-28T00:01:30.000Z', capturedAt: '2026-08-28T00:01:31.000Z',
    payload: { text: 'local' }, evidenceRefs: [],
  })
  await storage.sessionSummaryProjection.rebuild({ logicalSessionId: 'local-session' })
}

function remoteBody(title: string, startedAt: string, endedAt?: string) {
  return {
    title: { state: 'value', value: title },
    startedAt: { state: 'value', value: startedAt },
    endedAt: endedAt
      ? { state: 'value', value: endedAt }
      : { state: 'omitted', reason: 'policy' },
  } as const
}

test('H11 Unified Session list merges local with active remote and hides staged generations', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()
    await putLocalSession(storage)
    const store = new SqliteHubReplicaStore(storage.executor)
    const remote = new SqliteHubRemoteReadRepository(storage.executor)

    const activeId = replicaKeyFor(createOriginEntityRef('node-a', 'LogicalSession', 'remote-active'))
    const stagedId = replicaKeyFor(createOriginEntityRef('node-a', 'LogicalSession', 'remote-staged'))
    await store.putGeneration({
      originNodeId: 'node-a', generationId: 'gen-active', status: 'staged', createdAt: '2026-08-28T00:00:00.000Z',
    })
    await store.putEntity({
      originNodeId: 'node-a', generationId: 'gen-active', entityType: 'LogicalSession',
      originEntityId: 'remote-active', replicaKey: activeId, scope: 'node', entityVersion: 1,
      contentHash: 'active-hash', body: remoteBody('远程新会话', '2026-08-28T00:03:00.000Z'),
      updatedSequence: 1, updatedAt: '2026-08-28T00:04:00.000Z',
    })
    await store.activateGeneration('node-a', 'gen-active', '2026-08-28T00:04:00.000Z')

    await store.putGeneration({
      originNodeId: 'node-b', generationId: 'gen-staged', status: 'staged', createdAt: '2026-08-28T00:05:00.000Z',
    })
    await store.putEntity({
      originNodeId: 'node-b', generationId: 'gen-staged', entityType: 'LogicalSession',
      originEntityId: 'remote-staged', replicaKey: stagedId, scope: 'node', entityVersion: 1,
      contentHash: 'staged-hash', body: remoteBody('不可见会话', '2026-08-28T00:06:00.000Z'),
      updatedSequence: 1, updatedAt: '2026-08-28T00:06:30.000Z',
    })

    const reader = new HubUnifiedLogicalSessionReader(
      'hub-node', storage.repositories.sessions, remote, storage.sessionSummaries,
    )
    const items = await reader.list(20)

    assert.deepEqual(items.map(item => item.publicId), [activeId, 'local-session'])
    assert.equal(items.some(item => item.publicId === stagedId), false)
    assert.deepEqual(items[0]?.body.endedAt, { state: 'omitted', reason: 'policy' })
    assert.deepEqual(items[1]?.body.title, { state: 'value', value: '本机会话' })
    assert.equal(items[0]?.origin.kind, 'remote')
    assert.equal(items[1]?.origin.kind, 'local')
  } finally {
    storage.close()
  }
})
