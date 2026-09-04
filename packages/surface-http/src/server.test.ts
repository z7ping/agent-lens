import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { CapturePolicyService, StorageService } from '@agent-lens/core'
import {
  DefaultIdentityService,
  DefaultObservationService,
} from '@agent-lens/core-services'
import type {
  HealthResponseDto,
  InsightsResponseDto,
  SourceRecordResponseDto,
  TimelineResponseDto,
} from '@agent-lens/protocol'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { startHttpSurface } from './server'

test('concurrent Health requests share one storage probe', async () => {
  let probes = 0
  let releaseProbe: () => void = () => undefined
  const probeGate = new Promise<void>(resolve => { releaseProbe = resolve })
  const storage = {
    async health() {
      probes += 1
      await probeGate
      return { ok: true, schemaVersion: 6 }
    },
  } as unknown as StorageService
  const surface = await startHttpSurface(storage, { port: 0 })

  try {
    const base = `http://${surface.host}:${surface.port}`
    const requests = Array.from({ length: 6 }, () => fetch(`${base}/api/v1/health`))
    const deadline = Date.now() + 2_000
    while (probes === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(probes, 1)
    releaseProbe()

    const responses = await Promise.all(requests)
    assert.deepEqual(responses.map(response => response.status), [200, 200, 200, 200, 200, 200])
    assert.equal(probes, 1)

    const cachedResponse = await fetch(`${base}/api/v1/health`)
    assert.equal(cachedResponse.status, 200)
    assert.equal(probes, 1)
  } finally {
    releaseProbe()
    await surface.dispose()
  }
})

test('expired Health cache returns immediately while storage diagnostics refresh in background', async () => {
  let probes = 0
  let releaseRefresh: () => void = () => undefined
  const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve })
  const storage = {
    async health() {
      probes += 1
      if (probes > 1) await refreshGate
      return { ok: true, schemaVersion: 6, details: { probes } }
    },
  } as unknown as StorageService
  const surface = await startHttpSurface(storage, { port: 0 })

  try {
    const base = `http://${surface.host}:${surface.port}`
    assert.equal((await fetch(`${base}/api/v1/health`)).status, 200)
    assert.equal(probes, 1)

    await new Promise(resolve => setTimeout(resolve, 1_050))
    const response = await Promise.race([
      fetch(`${base}/api/v1/health`),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('health blocked on refresh')), 250)),
    ])
    assert.equal(response.status, 200)

    const deadline = Date.now() + 2_000
    while (probes < 2 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(probes, 2)
  } finally {
    releaseRefresh()
    await surface.dispose()
  }
})

test('HTTP surface reads and updates AgentLens-managed user source authorization', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  let configured = ['claude-code']
  const capturePolicy = {
    settings: {
      prompt: 'redacted',
      tool: 'redacted',
      config: 'redacted',
      environment: 'off',
      enabledSources: ['claude-code'],
    },
    getSourceConfiguration() {
      return {
        effectiveEnabledSources: ['claude-code'],
        configuredEnabledSources: configured,
        source: 'file' as const,
        editable: true,
        restartRequired: configured.includes('codex'),
      }
    },
    async setEnabledSources(values: readonly string[]) { configured = [...values] },
  } as unknown as CapturePolicyService
  const surface = await startHttpSurface(storage, { port: 0, capturePolicy })
  try {
    const url = `http://${surface.host}:${surface.port}/api/v1/capture-policy/sources`
    const initial = await fetch(url)
    assert.equal(initial.status, 200)
    assert.deepEqual((await initial.json() as { settings: { configuredEnabledSources: string[] } }).settings.configuredEnabledSources, ['claude-code'])

    const updated = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabledSources: ['claude-code', 'codex'] }),
    })
    assert.equal(updated.status, 200)
    const body = await updated.json() as { settings: { configuredEnabledSources: string[]; restartRequired: boolean } }
    assert.deepEqual(body.settings.configuredEnabledSources, ['claude-code', 'codex'])
    assert.equal(body.settings.restartRequired, true)

    const invalidType = await fetch(url, { method: 'PUT', body: JSON.stringify({ enabledSources: [] }) })
    assert.equal(invalidType.status, 415)
  } finally {
    await surface.dispose()
    storage.close()
  }
})

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


test('HTTP surface lazily exposes one safe SourceRecord for Raw Inspector', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  const identity = new DefaultIdentityService(storage)
  const host = await identity.resolveHost({ name: 'raw-inspector-host' })
  const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'codex' })
  await storage.repositories.sourceRecords.put({
    id: 'raw-source-record-1',
    sourceId: 'codex',
    installationId: installation.id,
    sourceSessionNativeId: 'thread-raw-1',
    nativeType: 'event_msg/token_count',
    nativeId: 'native-raw-1',
    sourceSequence: 7,
    occurredAt: '2026-08-31T10:00:00.000Z',
    capturedAt: '2026-08-31T10:00:01.000Z',
    locator: { kind: 'file', path: '/tmp/rollout.jsonl', offset: 128 },
    fingerprint: 'safe-fingerprint',
    payload: { type: 'event_msg', payload: { type: 'token_count', input_tokens: 12 } },
    parserVersion: '5',
  })
  const surface = await startHttpSurface(storage, { port: 0 })
  try {
    const response = await fetch(`http://${surface.host}:${surface.port}/api/v1/source-records/raw-source-record-1`)
    assert.equal(response.status, 200)
    const body = await response.json() as SourceRecordResponseDto
    assert.equal(body.nativeType, 'event_msg/token_count')
    assert.equal(body.nativeId, 'native-raw-1')
    assert.equal(body.parserVersion, '5')
    assert.equal(body.locator.path, '/tmp/rollout.jsonl')
    assert.equal(body.locator.offset, 128)
    assert.deepEqual(body.payload, { type: 'event_msg', payload: { type: 'token_count', input_tokens: 12 } })
  } finally {
    await surface.dispose()
    storage.close()
  }
})
