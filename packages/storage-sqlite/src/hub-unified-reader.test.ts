import assert from 'node:assert/strict'
import test from 'node:test'
import { createOriginEntityRef, replicaKeyFor } from '@agent-lens/core/replication'
import { HubUnifiedLogicalSessionReader } from './hub-unified-reader'
import { SqliteHubRemoteReadRepository } from './hub-remote-reader'
import { SqliteHubReplicaStore } from './hub-replica-store'
import { SqliteStorageService } from './storage'

test('H8 Unified Read keeps Local Canonical id and Remote ReplicaKey distinct even when origin ids collide', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()

    await storage.repositories.hosts.put({
      id: 'host-local',
      name: 'hub-local',
      platform: 'linux',
      arch: 'x64',
      createdAt: '2026-08-28T00:00:00.000Z',
      lastSeenAt: '2026-08-28T00:00:00.000Z',
    })
    await storage.repositories.installations.putProduct({
      id: 'codex',
      name: 'Codex',
    })
    await storage.repositories.installations.put({
      id: 'install-local',
      hostId: 'host-local',
      productId: 'codex',
      firstSeenAt: '2026-08-28T00:00:00.000Z',
      lastSeenAt: '2026-08-28T00:00:00.000Z',
    })
    const profile = await storage.runtimeProfiles.resolve({
      installationId: 'install-local',
      nativeProfileId: 'default',
      name: '默认',
    })
    await storage.repositories.sessions.putLogicalSession({
      id: 'session-1',
      installationId: 'install-local',
      runtimeProfileId: profile.id,
      title: '本机会话',
      startedAt: '2026-08-28T00:01:00.000Z',
    })

    const store = new SqliteHubReplicaStore(storage.executor)
    const remoteReader = new SqliteHubRemoteReadRepository(storage.executor)
    const unified = new HubUnifiedLogicalSessionReader(
      'hub-node',
      storage.repositories.sessions,
      remoteReader,
    )

    const remotePublicId = replicaKeyFor(createOriginEntityRef('node-a', 'LogicalSession', 'session-1'))
    await store.putGeneration({
      originNodeId: 'node-a',
      generationId: 'gen-a',
      status: 'staged',
      createdAt: '2026-08-28T00:02:00.000Z',
    })
    await store.putEntity({
      originNodeId: 'node-a',
      generationId: 'gen-a',
      entityType: 'LogicalSession',
      originEntityId: 'session-1',
      replicaKey: remotePublicId,
      scope: 'node',
      entityVersion: 1,
      contentHash: 'remote-session-hash',
      body: {
        id: { state: 'value', value: 'session-1' },
        installationId: { state: 'value', value: 'install-remote' },
        runtimeProfileId: { state: 'omitted', reason: 'not-captured' },
        projectId: { state: 'omitted', reason: 'not-captured' },
        workspaceId: { state: 'omitted', reason: 'not-captured' },
        title: { state: 'value', value: '远程会话' },
        startedAt: { state: 'value', value: '2026-08-28T00:02:00.000Z' },
        endedAt: { state: 'omitted', reason: 'not-captured' },
      },
      updatedSequence: 1,
      updatedAt: '2026-08-28T00:03:00.000Z',
    })

    const local = await unified.get('session-1')
    assert.equal(local?.publicId, 'session-1')
    assert.deepEqual(local?.origin, {
      kind: 'local',
      nodeId: 'hub-node',
      entityId: 'session-1',
    })
    assert.deepEqual(local?.body.runtimeProfileId, { state: 'value', value: profile.id })
    assert.deepEqual(local?.body.title, { state: 'value', value: '本机会话' })

    assert.equal(await unified.get(remotePublicId), undefined)

    await store.activateGeneration('node-a', 'gen-a', '2026-08-28T00:04:00.000Z')
    const remote = await unified.get(remotePublicId)
    assert.equal(remote?.publicId, remotePublicId)
    assert.deepEqual(remote?.origin, {
      kind: 'remote',
      nodeId: 'node-a',
      entityId: 'session-1',
      generationId: 'gen-a',
    })
    assert.deepEqual(remote?.body.title, { state: 'value', value: '远程会话' })
    assert.notEqual(local?.publicId, remote?.publicId)
  } finally {
    await storage.close()
  }
})
