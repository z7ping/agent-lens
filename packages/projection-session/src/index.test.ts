import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DefaultIdentityService,
  DefaultObservationService,
} from '@agent-lens/core-services'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { SessionProjection } from './index'

test('SessionProjection derives user interactions from canonical observations', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'session-projection-host' })
    const installation = await identity.resolveInstallation({
      hostId: host.id,
      productId: 'pi',
    })

    const add = async (
      kind: 'session.lifecycle' | 'message.user' | 'message.assistant' | 'tool.call' | 'tool.result',
      id: string,
      at: string,
      payload: unknown,
    ) => observations.commit({
      sourceId: 'pi',
      host,
      installation,
      candidate: {
        kind,
        nativeEventId: id,
        occurredAt: at,
        capturedAt: at,
        payload,
        identityHints: {
          nativeSessionId: 'pi-session-child',
          nativeParentSessionId: 'pi-session-parent',
          workspacePath: '/tmp/project',
        },
        dedupHints: { nativeEventId: id },
      },
      evidenceCandidates: [{
        captureMethod: 'native-log',
        derivation: 'reported',
        nativeStableId: id,
        capturedAt: at,
      }],
    })

    await add('session.lifecycle', 'session-start', '2026-08-20T10:00:00.000Z', { event: 'session.started' })
    const firstUser = await add('message.user', 'user-1', '2026-08-20T10:00:01.000Z', { text: 'inspect' })
    await add('message.assistant', 'assistant-1', '2026-08-20T10:00:02.000Z', { text: 'working' })
    await add('tool.call', 'tool-call-1', '2026-08-20T10:00:03.000Z', { callId: 'call-1', nativeToolName: 'bash' })
    await add('tool.result', 'tool-result-1', '2026-08-20T10:00:04.000Z', { callId: 'call-1', success: true })
    const secondUser = await add('message.user', 'user-2', '2026-08-20T10:00:05.000Z', { text: 'continue' })
    await add('message.assistant', 'assistant-2', '2026-08-20T10:00:06.000Z', { text: 'done' })

    const projection = new SessionProjection(storage)
    const response = await projection.query({ installationId: installation.id })
    assert.equal(response.items.length, 1)
    const session = response.items[0]!
    assert.equal(session.productId, 'pi')
    assert.deepEqual(session.sourceIds, ['pi'])
    assert.deepEqual(session.nativeSessionIds, ['pi-session-child'])
    assert.deepEqual(session.nativeParentSessionIds, ['pi-session-parent'])
    assert.equal(session.observationCount, 7)
    assert.equal(session.interactionCount, 2)
    assert.equal(session.observationCounts['message.user'], 2)
    assert.equal(session.observationCounts['tool.call'], 1)

    assert.equal(session.interactions[0]?.trigger, 'user')
    assert.equal(session.interactions[0]?.startObservationId, firstUser.observation.id)
    assert.equal(session.interactions[0]?.observationCount, 4)
    assert.equal(session.interactions[1]?.startObservationId, secondUser.observation.id)
    assert.equal(session.interactions[1]?.observationCount, 2)

    const byId = await projection.query({ logicalSessionId: session.id })
    assert.equal(byId.items.length, 1)
    assert.equal(byId.items[0]?.id, session.id)
  } finally {
    storage.close()
  }
})
