import assert from 'node:assert/strict'
import test from 'node:test'
import { createOriginEntityRef, replicaKeyFor } from '@agent-lens/core/replication'
import {
  HubUnifiedLogicalSessionReader,
  HubUnifiedObservationReader,
} from './hub-unified-reader'
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
    await storage.repositories.sessions.putSourceSession({
      id: 'source-session-local',
      sourceId: 'codex',
      installationId: 'install-local',
      runtimeProfileId: profile.id,
      nativeSessionId: 'native-local',
      logicalSessionId: 'session-1',
    })
    await storage.repositories.observations.put({
      id: 'observation-1',
      hostId: 'host-local',
      installationId: 'install-local',
      logicalSessionId: 'session-1',
      sourceSessionId: 'source-session-local',
      kind: 'message.user',
      capturedAt: '2026-08-28T00:01:30.000Z',
      payload: { text: '本机正文' },
      evidenceRefs: [],
    })

    const store = new SqliteHubReplicaStore(storage.executor)
    const remoteReader = new SqliteHubRemoteReadRepository(storage.executor)
    const unifiedSessions = new HubUnifiedLogicalSessionReader(
      'hub-node',
      storage.repositories.sessions,
      remoteReader,
    )
    const unifiedObservations = new HubUnifiedObservationReader(
      'hub-node',
      storage.repositories.observations,
      unifiedSessions,
      remoteReader,
    )

    const remotePublicId = replicaKeyFor(createOriginEntityRef('node-a', 'LogicalSession', 'session-1'))
    const remoteObservationPublicId = replicaKeyFor(createOriginEntityRef('node-a', 'CanonicalObservation', 'observation-1'))
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
    await store.putEntity({
      originNodeId: 'node-a',
      generationId: 'gen-a',
      entityType: 'CanonicalObservation',
      originEntityId: 'observation-1',
      replicaKey: remoteObservationPublicId,
      scope: 'node',
      entityVersion: 1,
      contentHash: 'remote-observation-hash',
      body: {
        id: { state: 'value', value: 'observation-1' },
        hostId: { state: 'value', value: 'host-remote' },
        installationId: { state: 'value', value: 'install-remote' },
        logicalSessionId: { state: 'value', value: 'session-1' },
        sourceSessionId: { state: 'value', value: 'source-session-remote' },
        kind: { state: 'value', value: 'message.user' },
        occurredAt: { state: 'null' },
        capturedAt: { state: 'value', value: '2026-08-28T00:02:30.000Z' },
        payload: { state: 'omitted', reason: 'policy' },
        evidenceRefs: { state: 'value', value: [] },
      },
      references: {
        logicalSession: {
          kind: 'node',
          entityType: 'LogicalSession',
          originEntityId: 'session-1',
        },
      },
      updatedSequence: 1,
      updatedAt: '2026-08-28T00:03:00.000Z',
    })

    const local = await unifiedSessions.get('session-1')
    assert.equal(local?.publicId, 'session-1')
    assert.deepEqual(local?.origin, {
      kind: 'local',
      nodeId: 'hub-node',
      entityId: 'session-1',
    })
    assert.deepEqual(local?.body.runtimeProfileId, { state: 'value', value: profile.id })
    assert.deepEqual(local?.body.title, { state: 'value', value: '本机会话' })

    const localObservations = await unifiedObservations.queryForLogicalSession('session-1')
    assert.equal(localObservations.length, 1)
    assert.equal(localObservations[0]?.publicId, 'observation-1')
    assert.deepEqual(localObservations[0]?.body.payload, {
      state: 'value',
      value: { text: '本机正文' },
    })

    assert.equal(await unifiedSessions.get(remotePublicId), undefined)
    assert.deepEqual(await unifiedObservations.queryForLogicalSession(remotePublicId), [])

    await store.activateGeneration('node-a', 'gen-a', '2026-08-28T00:04:00.000Z')
    const remote = await unifiedSessions.get(remotePublicId)
    assert.equal(remote?.publicId, remotePublicId)
    assert.deepEqual(remote?.origin, {
      kind: 'remote',
      nodeId: 'node-a',
      entityId: 'session-1',
      generationId: 'gen-a',
    })
    assert.deepEqual(remote?.body.title, { state: 'value', value: '远程会话' })
    assert.notEqual(local?.publicId, remote?.publicId)

    const remoteObservations = await unifiedObservations.queryForLogicalSession(remotePublicId)
    assert.equal(remoteObservations.length, 1)
    assert.equal(remoteObservations[0]?.publicId, remoteObservationPublicId)
    assert.deepEqual(remoteObservations[0]?.origin, {
      kind: 'remote',
      nodeId: 'node-a',
      entityId: 'observation-1',
      generationId: 'gen-a',
    })
    assert.deepEqual(remoteObservations[0]?.body.payload, {
      state: 'omitted',
      reason: 'policy',
    })
    assert.notEqual(localObservations[0]?.publicId, remoteObservations[0]?.publicId)
  } finally {
    await storage.close()
  }
})
