import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DefaultIdentityService,
  DefaultObservationService,
} from '@agent-lens/core-services'
import type {
  HealthResponseDto,
  TimelineResponseDto,
} from '@agent-lens/protocol'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { startHttpSurface } from './server'

test('HTTP surface exposes v1 health and timeline protocol on loopback', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()

  const identity = new DefaultIdentityService(storage)
  const observations = new DefaultObservationService(storage, identity)
  const host = await identity.resolveHost({ name: 'http-surface-host' })
  const installation = await identity.resolveInstallation({
    hostId: host.id,
    productId: 'codex',
  })

  await observations.commit({
    sourceId: 'codex',
    host,
    installation,
    candidate: {
      kind: 'message.user',
      nativeEventId: 'http-message-1',
      occurredAt: '2026-08-20T12:00:00.000Z',
      capturedAt: '2026-08-20T12:00:01.000Z',
      payload: { text: 'hello from canonical facts' },
      identityHints: { nativeSessionId: 'http-session-1' },
      dedupHints: { nativeEventId: 'http-message-1' },
    },
    evidenceCandidates: [{
      captureMethod: 'native-log',
      derivation: 'reported',
      nativeStableId: 'http-message-1',
      capturedAt: '2026-08-20T12:00:01.000Z',
    }],
  })

  const surface = await startHttpSurface(storage, { port: 0 })
  try {
    assert.equal(surface.host, '127.0.0.1')
    assert.ok(surface.port > 0)
    const base = `http://${surface.host}:${surface.port}`

    const healthResponse = await fetch(`${base}/api/v1/health`)
    assert.equal(healthResponse.status, 200)
    const health = await healthResponse.json() as HealthResponseDto
    assert.equal(health.status, 'ok')
    assert.equal(health.protocolVersion, '1.0')
    assert.equal(health.storage.ok, true)

    const timelineResponse = await fetch(
      `${base}/api/v1/timeline?installationId=${encodeURIComponent(installation.id)}&limit=10`,
    )
    assert.equal(timelineResponse.status, 200)
    const timeline = await timelineResponse.json() as TimelineResponseDto
    assert.equal(timeline.meta.protocolVersion, '1.0')
    assert.equal(timeline.items.length, 1)
    assert.equal(timeline.items[0]?.sourceId, 'codex')
    assert.equal(timeline.items[0]?.kind, 'message.user')
    assert.equal(timeline.items[0]?.evidence.length, 1)

    const badKind = await fetch(`${base}/api/v1/timeline?kind=not-a-real-kind`)
    assert.equal(badKind.status, 400)
    assert.deepEqual(await badKind.json(), {
      error: 'bad_request',
      message: 'Unknown timeline kind: not-a-real-kind',
    })

    const missing = await fetch(`${base}/api/v1/not-found`)
    assert.equal(missing.status, 404)
  } finally {
    await surface.dispose()
    storage.close()
  }
})
