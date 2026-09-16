import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DefaultIdentityService,
  DefaultObservationService,
} from '@agent-lens/core-services'
import { SqliteStorageService } from './storage'

const CAPTURED_AT = '2026-09-16T00:00:00.000Z'

test('重复提交 unchanged Observation 不再制造身份与 Evidence replication revision', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({
      name: 'devbox',
      platform: 'linux',
      arch: 'x64',
    })
    const installation = await identity.resolveInstallation({
      hostId: host.id,
      productId: 'codex',
      executable: '/usr/bin/codex',
    })

    const input = {
      sourceId: 'codex',
      host,
      installation,
      candidate: {
        kind: 'message.assistant' as const,
        nativeEventId: 'event-1',
        capturedAt: CAPTURED_AT,
        payload: { text: 'done' },
        identityHints: {
          nativeSessionId: 'session-native-1',
          nativeActorId: 'main',
          actorRole: 'main-agent' as const,
        },
        dedupHints: {
          nativeEventId: 'event-1',
        },
      },
      evidenceCandidates: [{
        captureMethod: 'native-log' as const,
        derivation: 'observed' as const,
        nativeStableId: 'event-1',
        capturedAt: CAPTURED_AT,
      }],
    }

    const beforeFirst = await storage.replicationCanonicalChanges.highWaterRevision()
    const first = await observations.commit(input)
    const afterFirst = await storage.replicationCanonicalChanges.highWaterRevision()
    assert.equal(first.status, 'created')
    assert.ok(afterFirst > beforeFirst)

    const second = await observations.commit(input)
    const afterSecond = await storage.replicationCanonicalChanges.highWaterRevision()
    assert.equal(second.status, 'unchanged')
    assert.equal(afterSecond, afterFirst)

    const changed = await observations.commit({
      ...input,
      candidate: {
        ...input.candidate,
        identityHints: {
          ...input.candidate.identityHints,
          sessionTitle: 'Renamed session',
        },
      },
    })
    const afterRealChange = await storage.replicationCanonicalChanges.highWaterRevision()
    assert.equal(changed.status, 'unchanged')
    assert.ok(afterRealChange > afterSecond)
  } finally {
    await storage.close()
  }
})
