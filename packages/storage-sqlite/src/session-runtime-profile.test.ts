import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'

test('session repositories round-trip runtimeProfileId after attachSession', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()
    const now = '2026-08-28T00:00:00.000Z'
    await storage.repositories.hosts.put({
      id: 'host-1', name: 'local', platform: 'linux', arch: 'x64', createdAt: now, lastSeenAt: now,
    })
    await storage.repositories.installations.putProduct({ id: 'dsh', name: 'DSH' })
    await storage.repositories.installations.put({
      id: 'install-1', hostId: 'host-1', productId: 'dsh', firstSeenAt: now, lastSeenAt: now,
    })
    await storage.repositories.sessions.putLogicalSession({ id: 'logical-1', installationId: 'install-1' })
    await storage.repositories.sessions.putSourceSession({
      id: 'source-1', sourceId: 'dsh', installationId: 'install-1',
      nativeSessionId: 'native-1', logicalSessionId: 'logical-1',
    })
    const profile = await storage.runtimeProfiles.resolve({
      installationId: 'install-1', nativeProfileId: 'default', name: 'default',
    })
    await storage.runtimeProfiles.attachSession('dsh', 'install-1', 'native-1', profile.id)

    assert.equal((await storage.repositories.sessions.getLogicalSession('logical-1'))?.runtimeProfileId, profile.id)
    assert.equal((await storage.repositories.sessions.getSourceSession('source-1'))?.runtimeProfileId, profile.id)
    assert.equal((await storage.repositories.sessions.findSourceSession('dsh', 'install-1', 'native-1'))?.runtimeProfileId, profile.id)
  } finally {
    await storage.close()
  }
})

test('session repository put persists explicit runtimeProfileId', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()
    const now = '2026-08-28T00:00:00.000Z'
    await storage.repositories.hosts.put({ id: 'host-1', name: 'local', platform: 'linux', arch: 'x64', createdAt: now, lastSeenAt: now })
    await storage.repositories.installations.putProduct({ id: 'dsh', name: 'DSH' })
    await storage.repositories.installations.put({ id: 'install-1', hostId: 'host-1', productId: 'dsh', firstSeenAt: now, lastSeenAt: now })
    const profile = await storage.runtimeProfiles.resolve({ installationId: 'install-1', nativeProfileId: 'default' })

    await storage.repositories.sessions.putLogicalSession({
      id: 'logical-1', installationId: 'install-1', runtimeProfileId: profile.id,
    })
    await storage.repositories.sessions.putSourceSession({
      id: 'source-1', sourceId: 'dsh', installationId: 'install-1', nativeSessionId: 'native-1',
      logicalSessionId: 'logical-1', runtimeProfileId: profile.id,
    })

    assert.equal((await storage.repositories.sessions.getLogicalSession('logical-1'))?.runtimeProfileId, profile.id)
    assert.equal((await storage.repositories.sessions.getSourceSession('source-1'))?.runtimeProfileId, profile.id)
  } finally {
    await storage.close()
  }
})

test('two RuntimeProfiles may persist the same nativeSessionId without collision', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()
    const now = '2026-09-17T00:00:00.000Z'
    await storage.repositories.hosts.put({ id: 'host-1', name: 'local', platform: 'linux', arch: 'x64', createdAt: now, lastSeenAt: now })
    await storage.repositories.installations.putProduct({ id: 'dsh', name: 'DSH' })
    await storage.repositories.installations.put({ id: 'install-1', hostId: 'host-1', productId: 'dsh', firstSeenAt: now, lastSeenAt: now })
    const profileA = await storage.runtimeProfiles.resolve({ installationId: 'install-1', nativeProfileId: 'profile-a' })
    const profileB = await storage.runtimeProfiles.resolve({ installationId: 'install-1', nativeProfileId: 'profile-b' })

    await storage.repositories.sessions.putLogicalSession({ id: 'logical-a', installationId: 'install-1', runtimeProfileId: profileA.id })
    await storage.repositories.sessions.putLogicalSession({ id: 'logical-b', installationId: 'install-1', runtimeProfileId: profileB.id })
    await storage.repositories.sessions.putSourceSession({
      id: 'source-a', sourceId: 'dsh', installationId: 'install-1', runtimeProfileId: profileA.id,
      nativeSessionId: 'same-id', logicalSessionId: 'logical-a',
    })
    await storage.repositories.sessions.putSourceSession({
      id: 'source-b', sourceId: 'dsh', installationId: 'install-1', runtimeProfileId: profileB.id,
      nativeSessionId: 'same-id', logicalSessionId: 'logical-b',
    })

    const rows = storage.db.prepare(`
      SELECT id, runtime_profile_id AS runtimeProfileId
      FROM source_sessions
      WHERE source_id = 'dsh' AND installation_id = 'install-1' AND native_session_id = 'same-id'
      ORDER BY id
    `).all() as Array<{ id: string; runtimeProfileId: string }>
    assert.deepEqual(rows, [
      { id: 'source-a', runtimeProfileId: profileA.id },
      { id: 'source-b', runtimeProfileId: profileB.id },
    ])
  } finally {
    await storage.close()
  }
})


test('session repository lists source sessions by logical session in one query surface', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()
    const now = '2026-09-18T00:00:00.000Z'
    await storage.repositories.hosts.put({ id: 'host-1', name: 'local', platform: 'linux', arch: 'x64', createdAt: now, lastSeenAt: now })
    await storage.repositories.installations.putProduct({ id: 'pi', name: 'Pi' })
    await storage.repositories.installations.put({ id: 'install-1', hostId: 'host-1', productId: 'pi', firstSeenAt: now, lastSeenAt: now })
    await storage.repositories.sessions.putLogicalSession({ id: 'logical-1', installationId: 'install-1' })
    await storage.repositories.sessions.putLogicalSession({ id: 'logical-2', installationId: 'install-1' })
    await storage.repositories.sessions.putSourceSession({
      id: 'source-a', sourceId: 'pi', installationId: 'install-1',
      nativeSessionId: 'native-a', logicalSessionId: 'logical-1', nativeParentSessionId: 'native-parent',
    })
    await storage.repositories.sessions.putSourceSession({
      id: 'source-b', sourceId: 'pi', installationId: 'install-1',
      nativeSessionId: 'native-b', logicalSessionId: 'logical-1',
    })
    await storage.repositories.sessions.putSourceSession({
      id: 'source-other', sourceId: 'pi', installationId: 'install-1',
      nativeSessionId: 'native-other', logicalSessionId: 'logical-2',
    })

    const list = storage.repositories.sessions.listSourceSessionsByLogicalSession
    assert.ok(list)
    assert.deepEqual((await list.call(storage.repositories.sessions, 'logical-1')).map(item => item.id), ['source-a', 'source-b'])
  } finally {
    await storage.close()
  }
})
