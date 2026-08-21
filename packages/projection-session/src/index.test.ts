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

test('SessionProjection keeps recent sessions visible after more than 5000 older observations', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'session-visibility-host' })
    const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'codex' })

    const addUser = (nativeSessionId: string, nativeEventId: string, at: string, text: string) => observations.commit({
      sourceId: 'codex',
      host,
      installation,
      candidate: {
        kind: 'message.user',
        nativeEventId,
        occurredAt: at,
        capturedAt: at,
        payload: { text },
        identityHints: { nativeSessionId },
        dedupHints: { nativeEventId },
      },
      evidenceCandidates: [],
    })

    const old = await addUser('old-session', 'old-root', '2026-07-01T00:00:00.000Z', 'old')
    const oldObservation = old.observation
    const insert = storage.db.prepare(`
      INSERT INTO observations(
        id, host_id, installation_id, project_id, workspace_id, logical_session_id, source_session_id,
        interaction_id, actor_id, kind, source_sequence, canonical_sequence, occurred_at, captured_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertMany = storage.db.transaction(() => {
      const base = Date.parse('2026-07-01T00:00:01.000Z')
      for (let index = 0; index < 5000; index += 1) {
        const at = new Date(base + index).toISOString()
        insert.run(
          `bulk-old-${index}`,
          oldObservation.hostId,
          oldObservation.installationId,
          oldObservation.projectId ?? null,
          oldObservation.workspaceId ?? null,
          oldObservation.logicalSessionId,
          oldObservation.sourceSessionId,
          null,
          null,
          'message.assistant',
          index + 2,
          index + 2,
          at,
          at,
          JSON.stringify({ text: `old-${index}` }),
        )
      }
    })
    insertMany()

    const recent = await addUser('recent-session', 'recent-root', '2026-08-21T12:00:00.000Z', 'recent')
    const projection = new SessionProjection(storage)

    const latest = await projection.query({ installationId: installation.id, limit: 1 })
    assert.equal(latest.items.length, 1)
    assert.equal(latest.items[0]?.id, recent.observation.logicalSessionId)
    assert.equal(latest.meta.hasMore, true)

    const oldById = await projection.query({ logicalSessionId: oldObservation.logicalSessionId, limit: 1 })
    assert.equal(oldById.items.length, 1)
    assert.equal(oldById.items[0]?.observationCount, 5001)
  } finally {
    storage.close()
  }
})
