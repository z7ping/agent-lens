import assert from 'node:assert/strict'
import test from 'node:test'
import { DataRuntimeClient } from './client'

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Data Runtime state')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('degraded worker recovery wait remains bounded by the caller timeout', async () => {
  const client = new DataRuntimeClient({
    role: 'writer',
    allowDiagnostics: true,
    heartbeatIntervalMs: 60_000,
  })
  await client.start()
  try {
    await client.request('diagnostic.exit').catch(() => undefined)
    await waitFor(() => client.state() === 'degraded')

    const startedAt = performance.now()
    await assert.rejects(
      client.request('ping', undefined, 80),
      /did not recover before request timeout/,
    )
    const elapsedMs = performance.now() - startedAt
    assert.ok(elapsedMs >= 70, `recovery wait returned too early: ${elapsedMs.toFixed(1)}ms`)
    assert.ok(elapsedMs < 500, `recovery wait exceeded bounded timeout: ${elapsedMs.toFixed(1)}ms`)
  } finally {
    await client.shutdown()
  }
})
