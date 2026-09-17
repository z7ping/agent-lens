import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'

async function seedProfileSessions(storage: SqliteStorageService) {
  const now = '2026-09-17T00:00:00.000Z'
  await storage.repositories.hosts.put({ id: 'host-1', name: 'local', platform: 'linux', arch: 'x64', createdAt: now, lastSeenAt: now })
  await storage.repositories.installations.putProduct({ id: 'dsh', name: 'DSH' })
  await storage.repositories.installations.put({ id: 'install-1', hostId: 'host-1', productId: 'dsh', firstSeenAt: now, lastSeenAt: now })
  const profileA = await storage.runtimeProfiles.resolve({ installationId: 'install-1', nativeProfileId: 'a' })
  const profileB = await storage.runtimeProfiles.resolve({ installationId: 'install-1', nativeProfileId: 'b' })

  for (const [suffix, profileId] of [['a', profileA.id], ['b', profileB.id]] as const) {
    await storage.repositories.sessions.putLogicalSession({ id: `logical-from-${suffix}`, installationId: 'install-1', runtimeProfileId: profileId })
    await storage.repositories.sessions.putLogicalSession({ id: `logical-to-${suffix}`, installationId: 'install-1', runtimeProfileId: profileId })
    await storage.repositories.sessions.putSourceSession({
      id: `source-from-${suffix}`, sourceId: 'dsh', installationId: 'install-1', runtimeProfileId: profileId,
      nativeSessionId: 'same-from', logicalSessionId: `logical-from-${suffix}`,
    })
    await storage.repositories.sessions.putSourceSession({
      id: `source-to-${suffix}`, sourceId: 'dsh', installationId: 'install-1', runtimeProfileId: profileId,
      nativeSessionId: 'same-to', logicalSessionId: `logical-to-${suffix}`,
    })
  }
  return { profileA, profileB }
}

test('relationship promotion never crosses RuntimeProfiles with identical native session ids', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()
    const { profileA, profileB } = await seedProfileSessions(storage)
    const repository = storage.sessionRelationshipCandidates

    const candidateA = {
      sourceId: 'dsh',
      installationId: 'install-1',
      runtimeProfileId: profileA.id,
      fromNativeSessionId: 'same-from',
      toNativeSessionId: 'same-to',
      type: 'continuation' as const,
      confidence: 'exact' as const,
      evidenceRefs: [],
    }
    const relationshipA = await repository.tryPromote(candidateA)
    assert.equal(relationshipA?.fromSessionId, 'logical-from-a')
    assert.equal(relationshipA?.toSessionId, 'logical-to-a')

    const candidateB = { ...candidateA, runtimeProfileId: profileB.id }
    const relationshipB = await repository.tryPromote(candidateB)
    assert.equal(relationshipB?.fromSessionId, 'logical-from-b')
    assert.equal(relationshipB?.toSessionId, 'logical-to-b')
    assert.notEqual(relationshipA?.id, relationshipB?.id)
  } finally {
    storage.close()
  }
})

test('legacy relationship candidate only sees legacy NULL-profile sessions', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()
    await seedProfileSessions(storage)
    const repository = storage.sessionRelationshipCandidates
    const candidate = {
      sourceId: 'dsh',
      installationId: 'install-1',
      fromNativeSessionId: 'same-from',
      toNativeSessionId: 'same-to',
      type: 'continuation' as const,
      confidence: 'exact' as const,
      evidenceRefs: [],
    }
    assert.equal(await repository.tryPromote(candidate), null)
  } finally {
    storage.close()
  }
})

test('tryPromoteForSession only retries candidates in the requested RuntimeProfile', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()
    const { profileA, profileB } = await seedProfileSessions(storage)
    const repository = storage.sessionRelationshipCandidates
    const base = {
      sourceId: 'dsh',
      installationId: 'install-1',
      fromNativeSessionId: 'same-from',
      toNativeSessionId: 'same-to',
      type: 'continuation' as const,
      confidence: 'exact' as const,
      evidenceRefs: [],
    }
    await repository.put({ ...base, runtimeProfileId: profileA.id })
    await repository.put({ ...base, runtimeProfileId: profileB.id })

    assert.equal(await repository.tryPromoteForSession('dsh', 'install-1', 'same-from', profileA.id), 1)
    const relationships = storage.db.prepare(`
      SELECT from_session_id AS fromSessionId, to_session_id AS toSessionId
      FROM session_relationships
      ORDER BY from_session_id
    `).all() as Array<{ fromSessionId: string; toSessionId: string }>
    assert.deepEqual(relationships, [{ fromSessionId: 'logical-from-a', toSessionId: 'logical-to-a' }])
  } finally {
    storage.close()
  }
})
