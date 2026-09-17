import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'

test('relationship promotion only resolves sessions inside the candidate RuntimeProfile', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()
    const now = '2026-09-17T00:00:00.000Z'
    await storage.repositories.hosts.put({ id: 'host-1', name: 'local', platform: 'linux', arch: 'x64', createdAt: now, lastSeenAt: now })
    await storage.repositories.installations.putProduct({ id: 'dsh', name: 'DSH' })
    await storage.repositories.installations.put({ id: 'install-1', hostId: 'host-1', productId: 'dsh', firstSeenAt: now, lastSeenAt: now })
    const profileA = await storage.runtimeProfiles.resolve({ installationId: 'install-1', nativeProfileId: 'a' })
    const profileB = await storage.runtimeProfiles.resolve({ installationId: 'install-1', nativeProfileId: 'b' })

    for (const [suffix, profileId] of [['a', profileA.id], ['b', profileB.id]] as const) {
      await storage.repositories.sessions.putLogicalSession({ id: `logical-root-${suffix}`, installationId: 'install-1', runtimeProfileId: profileId })
      await storage.repositories.sessions.putLogicalSession({ id: `logical-child-${suffix}`, installationId: 'install-1', runtimeProfileId: profileId })
      await storage.repositories.sessions.putSourceSession({
        id: `source-root-${suffix}`, sourceId: 'dsh', installationId: 'install-1', runtimeProfileId: profileId,
        nativeSessionId: 'root', logicalSessionId: `logical-root-${suffix}`,
      })
      await storage.repositories.sessions.putSourceSession({
        id: `source-child-${suffix}`, sourceId: 'dsh', installationId: 'install-1', runtimeProfileId: profileId,
        nativeSessionId: 'child', logicalSessionId: `logical-child-${suffix}`,
      })
    }

    const promoted = await storage.sessionRelationshipCandidates.tryPromote({
      sourceId: 'dsh',
      installationId: 'install-1',
      runtimeProfileId: profileB.id,
      fromNativeSessionId: 'root',
      toNativeSessionId: 'child',
      type: 'continuation',
      confidence: 'exact',
      evidenceRefs: [],
    })
    assert.equal(promoted?.fromSessionId, 'logical-root-b')
    assert.equal(promoted?.toSessionId, 'logical-child-b')

    const noProfile = await storage.sessionRelationshipCandidates.tryPromote({
      sourceId: 'dsh',
      installationId: 'install-1',
      fromNativeSessionId: 'root',
      toNativeSessionId: 'child',
      type: 'continuation',
      confidence: 'exact',
      evidenceRefs: [],
    })
    assert.equal(noProfile, null)
  } finally {
    await storage.close()
  }
})
