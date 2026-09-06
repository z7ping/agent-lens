import assert from 'node:assert/strict'
import test from 'node:test'
import { DataRuntimeClient } from './client'

test('ordinary request timeout does not recycle the shared Worker', async () => {
  const client = new DataRuntimeClient({
    allowDiagnostics: true,
    role: 'reader',
    heartbeatIntervalMs: 60_000,
  })
  await client.start()
  try {
    await assert.rejects(
      client.request('diagnostic.block', { durationMs: 120 }, 20),
      /request timed out/,
    )
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(client.state(), 'ready')
    await client.request('ping', undefined, 1_000)
    assert.equal(client.snapshot().livenessFailures, 0)
  } finally {
    await client.shutdown()
  }
})
