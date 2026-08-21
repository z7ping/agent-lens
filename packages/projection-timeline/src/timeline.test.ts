import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DefaultIdentityService,
  DefaultObservationService,
} from '@agent-lens/core-services'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { TimelineProjection } from './index'

test('TimelineProjection maps canonical facts to protocol DTOs in effective-time order', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()

  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({
      name: 'timeline-host',
      platform: process.platform,
      arch: process.arch,
    })
    const installation = await identity.resolveInstallation({
      hostId: host.id,
      productId: 'codex',
      configRoot: '/tmp/codex',
      dataRoot: '/tmp/codex/sessions',
    })

    const toolCandidate = {
      kind: 'tool.call' as const,
      nativeCallId: 'call-1',
      sourceSequence: 1,
      occurredAt: '2026-08-20T10:00:00.000Z',
      capturedAt: '2026-08-20T10:00:01.000Z',
      payload: {
        callId: 'call-1',
        nativeToolName: 'shell_command',
        input: { command: 'npm test' },
      },
      identityHints: {
        nativeSessionId: 'session-1',
        workspacePath: '/tmp/project',
      },
      dedupHints: { nativeCallId: 'call-1' },
    }

    await observations.commit({
      sourceId: 'codex',
      host,
      installation,
      candidate: toolCandidate,
      evidenceCandidates: [{
        captureMethod: 'native-log',
        derivation: 'reported',
        nativeStableId: 'call-1',
        sourceLocator: { kind: 'file', path: '/tmp/codex/session.jsonl', offset: 42 },
        parserVersion: '1',
        eventTime: toolCandidate.occurredAt,
        capturedAt: toolCandidate.capturedAt,
      }],
    })

    await observations.commit({
      sourceId: 'codex',
      host,
      installation,
      candidate: {
        ...toolCandidate,
        capturedAt: '2026-08-20T10:00:02.000Z',
      },
      evidenceCandidates: [{
        captureMethod: 'runtime-hook',
        derivation: 'observed',
        nativeStableId: 'call-1',
        sourceLocator: { kind: 'runtime-hook', hookEventId: 'hook-call-1' },
        eventTime: toolCandidate.occurredAt,
        capturedAt: '2026-08-20T10:00:02.000Z',
      }],
    })

    await observations.commit({
      sourceId: 'codex',
      host,
      installation,
      candidate: {
        kind: 'message.user',
        nativeEventId: 'message-1',
        sourceSequence: 2,
        occurredAt: '2026-08-20T09:00:00.000Z',
        capturedAt: '2026-08-20T09:00:01.000Z',
        payload: { text: 'earlier event' },
        identityHints: {
          nativeSessionId: 'session-1',
          workspacePath: '/tmp/project',
        },
        dedupHints: { nativeEventId: 'message-1' },
      },
      evidenceCandidates: [{
        captureMethod: 'native-log',
        derivation: 'reported',
        nativeStableId: 'message-1',
        sourceLocator: { kind: 'file', path: '/tmp/codex/session.jsonl', offset: 10 },
        parserVersion: '1',
        eventTime: '2026-08-20T09:00:00.000Z',
        capturedAt: '2026-08-20T09:00:01.000Z',
      }],
    })

    const projection = new TimelineProjection(storage)
    const response = await projection.query({
      installationId: installation.id,
      limit: 10,
    })

    assert.equal(response.meta.protocolVersion, '1.0')
    assert.equal(response.meta.count, 2)
    assert.equal(response.meta.hasMore, false)
    assert.equal(response.items[0]?.kind, 'message.user')
    assert.equal(response.items[0]?.effectiveAt, '2026-08-20T09:00:00.000Z')

    const tool = response.items[1]
    assert.ok(tool)
    assert.equal(tool.kind, 'tool.call')
    assert.equal(tool.sourceId, 'codex')
    assert.equal(tool.productId, 'codex')
    assert.equal(tool.evidence.length, 2)
    assert.deepEqual(
      new Set(tool.evidence.map(item => item.captureMethod)),
      new Set(['native-log', 'runtime-hook']),
    )
  } finally {
    storage.close()
  }
})

test('TimelineProjection uses a stable cursor without duplicate or missing observations', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()

  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'timeline-limit-host' })
    const installation = await identity.resolveInstallation({
      hostId: host.id,
      productId: 'codex',
    })

    for (const [sequence, hour] of [[1, 12], [2, 8], [3, 10]] as const) {
      const occurredAt = `2026-08-20T${String(hour).padStart(2, '0')}:00:00.000Z`
      await observations.commit({
        sourceId: 'codex',
        host,
        installation,
        candidate: {
          kind: 'unknown',
          nativeEventId: `event-${sequence}`,
          sourceSequence: sequence,
          occurredAt,
          capturedAt: occurredAt,
          payload: { sequence },
          identityHints: { nativeSessionId: 'session-limit' },
          dedupHints: { nativeEventId: `event-${sequence}` },
        },
        evidenceCandidates: [{
          captureMethod: 'native-log',
          derivation: 'reported',
          nativeStableId: `event-${sequence}`,
          capturedAt: occurredAt,
        }],
      })
    }

    const projection = new TimelineProjection(storage)
    const first = await projection.query({ installationId: installation.id, limit: 2 })
    assert.equal(first.meta.count, 2)
    assert.equal(first.meta.hasMore, true)
    assert.ok(first.meta.nextCursor)
    assert.deepEqual(
      first.items.map(item => item.effectiveAt),
      ['2026-08-20T08:00:00.000Z', '2026-08-20T10:00:00.000Z'],
    )

    const second = await projection.query({
      installationId: installation.id,
      limit: 2,
      cursor: first.meta.nextCursor,
    })
    assert.equal(second.meta.hasMore, false)
    assert.deepEqual(second.items.map(item => item.effectiveAt), ['2026-08-20T12:00:00.000Z'])
    assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 3)
  } finally {
    storage.close()
  }
})
