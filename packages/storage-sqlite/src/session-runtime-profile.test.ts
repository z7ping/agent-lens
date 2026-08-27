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
