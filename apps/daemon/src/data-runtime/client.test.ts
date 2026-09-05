import assert from 'node:assert/strict'
import test from 'node:test'
import { DataRuntimeClient } from './client'

test('Data Runtime worker starts with versioned IPC and shuts down cleanly', async () => {
  const client = new DataRuntimeClient({ allowDiagnostics: true, requestTimeoutMs: 2_000 })
  await client.start()
  try {
    assert.equal(client.state(), 'ready')
    const status = await client.request<{ ok: boolean; protocolVersion: number; threadId: number }>('status')
    assert.equal(status.ok, true)
    assert.equal(status.protocolVersion, 1)
    assert.ok(status.threadId > 0)
    const snapshot = client.snapshot()
    assert.equal(snapshot.state, 'ready')
    assert.ok(snapshot.completed >= 2)
    assert.ok(snapshot.durationMs.p95 >= 0)
  } finally {
    await client.shutdown()
  }
  assert.equal(client.state(), 'stopped')
})

test('synchronous Data Runtime work does not block the control-plane event loop', async () => {
  const client = new DataRuntimeClient({ allowDiagnostics: true, requestTimeoutMs: 2_000 })
  await client.start()
  try {
    const startedAt = performance.now()
    const blocking = client.request<{ blockedMs: number }>('diagnostic.block', { durationMs: 150 })
    await new Promise<void>(resolve => setTimeout(resolve, 20))
    const controlPlaneDelay = performance.now() - startedAt

    assert.ok(
      controlPlaneDelay < 100,
      `control-plane timer was blocked for ${controlPlaneDelay.toFixed(1)}ms`,
    )
    assert.equal((await blocking).blockedMs, 150)
  } finally {
    await client.shutdown()
  }
})

test('Data Runtime client rejects oversized messages before posting to worker', async () => {
  const client = new DataRuntimeClient({ allowDiagnostics: true })
  await client.start()
  try {
    await assert.rejects(
      client.request('diagnostic.block', { payload: 'x'.repeat(300 * 1024) }),
      /exceeds size limit/,
    )
  } finally {
    await client.shutdown()
  }
})
