import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DefaultIdentityService,
  DefaultObservationService,
} from '@agent-lens/core-services'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { TimelineProjection, timelineProjectionInternals } from './index'

test('TimelineProjection deduplicates and bounds concurrent identity lookups', async () => {
  let active = 0
  let maxActive = 0
  let calls = 0
  const ids = Array.from({ length: 200 }, (_, index) => `identity-${index % 100}`)

  const values = await timelineProjectionInternals.loadUniqueById(ids, async id => {
    calls += 1
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise(resolve => setTimeout(resolve, 1))
    active -= 1
    return { id }
  })

  assert.equal(values.size, 100)
  assert.equal(calls, 100)
  assert.ok(maxActive <= timelineProjectionInternals.IDENTITY_LOOKUP_CONCURRENCY)
})

test('TimelineProjection maps a full page without repeating shared identity reads', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()

  try {
    const identity = new DefaultIdentityService(storage)
    const observationService = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'timeline-shared-identity-host' })
    const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'codex' })
    await observationService.commit({
      sourceId: 'codex',
      host,
      installation,
      candidate: {
        kind: 'message.user',
        nativeEventId: 'shared-identity-event',
        capturedAt: '2026-09-06T00:00:00.000Z',
        payload: { text: 'shared identity' },
        identityHints: { nativeSessionId: 'shared-identity-session' },
        dedupHints: { nativeEventId: 'shared-identity-event' },
      },
      evidenceCandidates: [],
    })
    const observation = (await storage.repositories.observations.query({ limit: 1 }))[0]
    assert.ok(observation)

    const originalSourceSession = storage.repositories.sessions.getSourceSession.bind(storage.repositories.sessions)
    const originalInstallation = storage.repositories.installations.get.bind(storage.repositories.installations)
    let sourceSessionReads = 0
    let installationReads = 0
    storage.repositories.sessions.getSourceSession = async id => {
      sourceSessionReads += 1
      await new Promise(resolve => setTimeout(resolve, 1))
      return originalSourceSession(id)
    }
    storage.repositories.installations.get = async id => {
      installationReads += 1
      await new Promise(resolve => setTimeout(resolve, 1))
      return originalInstallation(id)
    }

    const page = Array.from({ length: 250 }, (_, index) => ({
      ...observation,
      id: `${observation.id}-${index}`,
      canonicalSequence: index + 1,
    }))
    const items = await new TimelineProjection(storage).mapObservations(page)

    assert.equal(items.length, 250)
    assert.equal(sourceSessionReads, 1)
    assert.equal(installationReads, 1)
  } finally {
    storage.close()
  }
})

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
    assert.equal(response.meta.direction, 'forward')
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

test('TimelineProjection paginates backward from the tail without duplicate or missing observations', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()

  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'timeline-backward-host' })
    const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'codex' })

    for (const hour of [8, 10, 12]) {
      const occurredAt = `2026-08-20T${String(hour).padStart(2, '0')}:00:00.000Z`
      await observations.commit({
        sourceId: 'codex', host, installation,
        candidate: {
          kind: 'unknown', nativeEventId: `backward-${hour}`, sourceSequence: hour,
          occurredAt, capturedAt: occurredAt, payload: { hour },
          identityHints: { nativeSessionId: 'session-backward' },
          dedupHints: { nativeEventId: `backward-${hour}` },
        },
        evidenceCandidates: [],
      })
    }

    const projection = new TimelineProjection(storage)
    const latest = await projection.query({ installationId: installation.id, direction: 'backward', limit: 2 })
    assert.equal(latest.meta.direction, 'backward')
    assert.equal(latest.meta.hasMore, true)
    assert.ok(latest.meta.nextCursor)
    assert.deepEqual(latest.items.map(item => item.effectiveAt), [
      '2026-08-20T10:00:00.000Z',
      '2026-08-20T12:00:00.000Z',
    ])

    const older = await projection.query({
      installationId: installation.id,
      direction: 'backward',
      cursor: latest.meta.nextCursor,
      limit: 2,
    })
    assert.equal(older.meta.hasMore, false)
    assert.deepEqual(older.items.map(item => item.effectiveAt), ['2026-08-20T08:00:00.000Z'])
    assert.equal(new Set([...older.items, ...latest.items].map(item => item.id)).size, 3)
  } finally {
    storage.close()
  }
})
