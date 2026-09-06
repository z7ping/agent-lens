import assert from 'node:assert/strict'
import test from 'node:test'
import type { StorageService } from '@agent-lens/core'
import type { DataRuntimeHealthDto, HealthResponseDto } from '@agent-lens/protocol'
import { httpSurfacePluginInternals } from './plugin'
import { startHttpSurface } from './server'

function degradedRuntimeHealth(): DataRuntimeHealthDto {
  const durationMs = { last: 0, max: 0, p50: 0, p95: 0, p99: 0 }
  return {
    ok: false,
    recovering: true,
    writer: {
      state: 'degraded',
      role: 'writer',
      protocolVersion: 1,
      pending: 0,
      maxPending: 0,
      requests: 0,
      completed: 0,
      timeouts: 0,
      durationMs,
    },
    reader: {
      state: 'degraded',
      role: 'reader',
      protocolVersion: 1,
      pending: 0,
      maxPending: 0,
      requests: 0,
      completed: 0,
      timeouts: 0,
      durationMs,
    },
  }
}

test('Data Runtime degraded keeps ready online while health reports degraded', async () => {
  const unavailableStorage = {
    async health() {
      throw new Error('reader worker unavailable')
    },
  } as unknown as StorageService
  const storage = httpSurfacePluginInternals.storageWithRuntimeHealth(
    unavailableStorage,
    degradedRuntimeHealth,
  )
  const surface = await startHttpSurface(storage, { port: 0 })
  try {
    const base = `http://${surface.host}:${surface.port}`
    const ready = await fetch(`${base}/api/v1/ready`)
    assert.equal(ready.status, 200)
    assert.equal((await ready.json() as { status: string }).status, 'ok')

    const health = await fetch(`${base}/api/v1/health`)
    assert.equal(health.status, 503)
    const body = await health.json() as HealthResponseDto
    assert.equal(body.status, 'degraded')
    assert.equal(body.storage.ok, false)
    assert.equal(body.storage.details?.storageUnavailable, true)
    assert.equal((body.storage.details?.dataRuntime as { recovering?: boolean } | undefined)?.recovering, true)
  } finally {
    await surface.dispose()
  }
})

test('HTTP health can expose O(1) maintenance fairness metrics without changing storage ownership', async () => {
  const storage = {
    async health() {
      return { ok: true, schemaVersion: 18, details: { sqlite: 'ok' } }
    },
  } as unknown as StorageService
  const healthStorage = httpSurfacePluginInternals.storageWithRuntimeHealth(
    storage,
    undefined,
    undefined,
    () => ({
      maintenanceGate: {
        permits: { quiet: 3, forced: 2, maxWaitMs: 5_000 },
        policy: { quietMs: 5_000, maxDeferMs: 5_000 },
      },
    }),
  )

  const health = await healthStorage.health()
  assert.equal(health.ok, true)
  assert.equal(health.schemaVersion, 18)
  assert.deepEqual(health.details?.maintenanceGate, {
    permits: { quiet: 3, forced: 2, maxWaitMs: 5_000 },
    policy: { quietMs: 5_000, maxDeferMs: 5_000 },
  })
})
