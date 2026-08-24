import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DefaultIdentityService,
  DefaultObservationService,
} from '@agent-lens/core-services'
import type {
  HealthResponseDto,
  InsightsResponseDto,
  TimelineResponseDto,
} from '@agent-lens/protocol'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { startHttpSurface } from './server'

test('HTTP surface exposes v1 API and production web assets on loopback', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  const webRoot = await mkdtemp(join(tmpdir(), 'agent-lens-web-'))
  await mkdir(join(webRoot, 'assets'), { recursive: true })
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>AgentLens Web</title>', 'utf8')
  await writeFile(join(webRoot, 'assets', 'app.js'), 'console.log("agent-lens")', 'utf8')

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

  const surface = await startHttpSurface(storage, { port: 0, staticDir: webRoot })
  try {
    assert.equal(surface.host, '127.0.0.1')
    assert.ok(surface.port > 0)
    const base = `http://${surface.host}:${surface.port}`

    const healthResponse = await fetch(`${base}/api/v1/health`)
    assert.equal(healthResponse.status, 200)
    const health = await healthResponse.json() as HealthResponseDto
    assert.equal(health.status, 'ok')
    assert.equal(health.protocolVersion, '1.0')
    assert.ok(health.runtime)
    assert.equal(health.runtime.owner, 'unknown')
    assert.equal(health.runtime.mode, 'foreground')
    assert.equal(health.runtime.pid, process.pid)
    assert.ok(Number.isFinite(Date.parse(health.runtime.startedAt)))
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

    const insightsResponse = await fetch(
      `${base}/api/v1/insights?from=${encodeURIComponent('2026-08-01T00:00:00.000Z')}&to=${encodeURIComponent('2026-08-31T23:59:59.999Z')}`,
    )
    assert.equal(insightsResponse.status, 200)
    const insights = await insightsResponse.json() as InsightsResponseDto
    assert.equal(insights.meta.protocolVersion, '1.0')
    assert.equal(insights.summary.sessionCount, 1)
    assert.equal(insights.summary.interactionCount, 1)

    const badInsightsRange = await fetch(
      `${base}/api/v1/insights?from=${encodeURIComponent('2026-09-01T00:00:00.000Z')}&to=${encodeURIComponent('2026-08-01T00:00:00.000Z')}`,
    )
    assert.equal(badInsightsRange.status, 400)
    assert.deepEqual(await badInsightsRange.json(), {
      error: 'bad_request',
      message: 'Insights from must be earlier than or equal to to',
    })

    const home = await fetch(`${base}/`)
    assert.equal(home.status, 200)
    assert.match(home.headers.get('content-type') ?? '', /^text\/html/)
    assert.match(await home.text(), /AgentLens Web/)

    const asset = await fetch(`${base}/assets/app.js`)
    assert.equal(asset.status, 200)
    assert.match(asset.headers.get('content-type') ?? '', /^text\/javascript/)
    assert.match(await asset.text(), /agent-lens/)

    const spaRoute = await fetch(`${base}/sessions/http-session-1`)
    assert.equal(spaRoute.status, 200)
    assert.match(await spaRoute.text(), /AgentLens Web/)

    const missingAsset = await fetch(`${base}/assets/missing.js`)
    assert.equal(missingAsset.status, 404)

    const badKind = await fetch(`${base}/api/v1/timeline?kind=not-a-real-kind`)
    assert.equal(badKind.status, 400)
    assert.deepEqual(await badKind.json(), {
      error: 'bad_request',
      message: 'Unknown timeline kind: not-a-real-kind',
    })

    const missingApi = await fetch(`${base}/api/v1/not-found`)
    assert.equal(missingApi.status, 404)
    assert.deepEqual(await missingApi.json(), { error: 'not_found' })
  } finally {
    await surface.dispose()
    storage.close()
    await rm(webRoot, { recursive: true, force: true })
  }
})