import assert from 'node:assert/strict'
import test from 'node:test'
import { DataRuntimeClient } from './client'
import { createDataRuntimeStorage } from './storage-proxy'

test('shared :memory: client still reports logical writer/reader roles', async () => {
  const writer = new DataRuntimeClient({
    role: 'writer',
    dbPath: ':memory:',
    nodeId: 'memory-health-test',
  })
  await writer.start()
  const runtime = createDataRuntimeStorage(writer, writer)

  try {
    const health = runtime.dataRuntime.snapshot()
    assert.equal(health.writer.role, 'writer')
    assert.equal(health.reader.role, 'reader')
    assert.equal(health.writer.state, 'ready')
    assert.equal(health.reader.state, 'ready')
    assert.equal(health.ok, true)
  } finally {
    await runtime.dataRuntime.shutdown()
  }
})
