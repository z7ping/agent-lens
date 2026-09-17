import assert from 'node:assert/strict'
import test from 'node:test'
import { DefaultIdentityService, DefaultObservationService } from '@agent-lens/core-services'
import { SqliteStorageService } from './storage'

async function fixture() {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  const identity = new DefaultIdentityService(storage)
  const observations = new DefaultObservationService(storage, identity)
  const host = await identity.resolveHost({ name: 'local', platform: 'linux', arch: 'x64' })
  const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'dsh' })
  return { storage, identity, observations, host, installation }
}

test('same native session id resolves to separate logical and source sessions per RuntimeProfile', async () => {
  const { storage, observations, host, installation } = await fixture()
  try {
    const commit = (profile: string, event: string) => observations.commit({
      sourceId: 'dsh',
      host,
      installation,
      candidate: {
        kind: 'message.assistant',
        nativeEventId: event,
        capturedAt: '2026-09-17T00:00:00.000Z',
        payload: { profile },
        identityHints: {
          nativeSessionId: 'same-native-session',
          runtimeProfileNativeId: profile,
        },
        dedupHints: { nativeEventId: event },
      },
      evidenceCandidates: [],
    })

    const writerObservation = (await commit('writer', 'event-writer')).observation
    const reviewerObservation = (await commit('reviewer', 'event-reviewer')).observation
    assert.notEqual(writerObservation.logicalSessionId, reviewerObservation.logicalSessionId)
    assert.notEqual(writerObservation.sourceSessionId, reviewerObservation.sourceSessionId)

    const writerProfile = await storage.runtimeProfiles.resolve({ installationId: installation.id, nativeProfileId: 'writer' })
    const reviewerProfile = await storage.runtimeProfiles.resolve({ installationId: installation.id, nativeProfileId: 'reviewer' })
    const writerSource = await storage.repositories.sessions.findSourceSession(
      'dsh', installation.id, 'same-native-session', writerProfile.id,
    )
    const reviewerSource = await storage.repositories.sessions.findSourceSession(
      'dsh', installation.id, 'same-native-session', reviewerProfile.id,
    )
    assert.equal(writerSource?.runtimeProfileId, writerProfile.id)
    assert.equal(reviewerSource?.runtimeProfileId, reviewerProfile.id)
    assert.equal(
      (await storage.repositories.sessions.getLogicalSession(writerObservation.logicalSessionId))?.runtimeProfileId,
      writerProfile.id,
    )
    assert.equal(
      (await storage.repositories.sessions.getLogicalSession(reviewerObservation.logicalSessionId))?.runtimeProfileId,
      reviewerProfile.id,
    )
  } finally {
    storage.close()
  }
})

test('legacy no-profile session identity remains stable and isolated from profiled sessions', async () => {
  const { storage, identity, installation } = await fixture()
  try {
    const firstLogical = await identity.resolveLogicalSession({ installationId: installation.id, nativeSessionId: 'legacy-native' })
    const secondLogical = await identity.resolveLogicalSession({ installationId: installation.id, nativeSessionId: 'legacy-native' })
    assert.equal(firstLogical.id, secondLogical.id)
    assert.equal(firstLogical.runtimeProfileId, undefined)

    const firstSource = await identity.resolveSourceSession({
      sourceId: 'dsh', installationId: installation.id, nativeSessionId: 'legacy-native', logicalSessionId: firstLogical.id,
    })
    const secondSource = await identity.resolveSourceSession({
      sourceId: 'dsh', installationId: installation.id, nativeSessionId: 'legacy-native', logicalSessionId: firstLogical.id,
    })
    assert.equal(firstSource.id, secondSource.id)
    assert.equal(firstSource.runtimeProfileId, undefined)

    const profile = await storage.runtimeProfiles.resolve({ installationId: installation.id, nativeProfileId: 'writer' })
    const profiledLogical = await identity.resolveLogicalSession({
      installationId: installation.id, runtimeProfileId: profile.id, nativeSessionId: 'legacy-native',
    })
    const profiledSource = await identity.resolveSourceSession({
      sourceId: 'dsh', installationId: installation.id, runtimeProfileId: profile.id,
      nativeSessionId: 'legacy-native', logicalSessionId: profiledLogical.id,
    })
    assert.notEqual(profiledLogical.id, firstLogical.id)
    assert.notEqual(profiledSource.id, firstSource.id)
    assert.equal(
      (await storage.repositories.sessions.findSourceSession('dsh', installation.id, 'legacy-native'))?.id,
      firstSource.id,
    )
  } finally {
    storage.close()
  }
})
