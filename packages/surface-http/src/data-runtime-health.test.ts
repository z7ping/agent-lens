import assert from 'node:assert/strict'
import test from 'node:test'
import type { StorageService } from '@agent-lens/core'
import { httpSurfacePluginInternals } from './plugin'
import { startHttpSurface } from './server'

test('Data Runtime degraded keeps ready online while health reports degraded', async () => {
  const unavailableStorage = {
    async health() {
      throw new Error('reader worker unavailable')
    },
  } as unknown as StorageService
  const storage = httpSurfacePluginInternals.storageWithRuntimeHealth(
    unavailableStorage,
    () => ({
      ok: false,
      recovering: true,
      writer: { state: 'degraded' },
      reader: { state: 'degraded' },
    }),
  )
  const surface = await startHttpSurface(storage, { port: 0 })
  try {
    const base = `http://${surface.host}:${surface.port}`
    const ready = await fetch(`${base}/api/v1/ready`)
    assert.equal(ready.status, 200)
    assert.equal((await ready.json() as { status: string }).status, 'ok')

    const health = await fetch(`${base}/api/v1/health`)
    assert.equal(health.status, 503)
    const body = await health.json() as any
    assert.equal(body.status, 'degraded')
    assert.equal(body.storage.ok, false)
    assert.equal(body.storage.details.storageUnavailable, true)
    assert.equal(body.storage.details.dataRuntime.recovering, true)
  } finally {
    await surface.dispose()
  }
})
