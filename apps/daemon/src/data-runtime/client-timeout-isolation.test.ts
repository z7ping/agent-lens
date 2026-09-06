import assert from 'node:assert/strict'
import test from 'node:test'
import { DataRuntimeClient } from './client'

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Data Runtime state')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

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

test('heartbeat timeout recycles a genuinely unresponsive Worker', async () => {
  const client = new DataRuntimeClient({
    allowDiagnostics: true,
    role: 'reader',
    heartbeatIntervalMs: 50,
    heartbeatTimeoutMs: 50,
  })
  await client.start()
  try {
    void client.request('diagnostic.block', { durationMs: 250 }, 1_000).catch(() => undefined)
    await waitFor(() => client.state() === 'degraded')
    const snapshot = client.snapshot()
    assert.equal(snapshot.livenessFailures, 1)
    assert.ok(snapshot.timeouts >= 1)
  } finally {
    await client.shutdown()
  }
})
