import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DataRuntimeClient } from './client'
import { createDataRuntimeStorage } from './storage-proxy'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-data-runtime-'))
  const dbPath = join(root, 'agent-lens.db')
  const writer = new DataRuntimeClient({
    role: 'writer',
    dbPath,
    nodeId: 'node-test',
    allowDiagnostics: true,
    requestTimeoutMs: 5_000,
  })
  const reader = new DataRuntimeClient({
    role: 'reader',
    dbPath,
    nodeId: 'node-test',
    allowDiagnostics: true,
    requestTimeoutMs: 5_000,
  })
  await writer.start()
  await reader.start()
  const runtime = createDataRuntimeStorage(writer, reader)
  return {
    root,
    writer,
    reader,
    ...runtime,
    async dispose() {
      await runtime.dataRuntime.shutdown()
      await rm(root, { recursive: true, force: true })
    },
  }
}

const host = (id: string) => ({
  id,
  name: id,
  platform: 'linux',
  arch: 'x64',
  createdAt: '2026-09-06T00:00:00.000Z',
  lastSeenAt: '2026-09-06T00:00:00.000Z',
})

test('Data Runtime uses writer for mutations and reader for committed reads', async () => {
  const runtime = await fixture()
  try {
    await runtime.storage.repositories.hosts.put(host('host-1'))
    assert.equal((await runtime.storage.repositories.hosts.get('host-1'))?.name, 'host-1')
    assert.equal(runtime.writer.snapshot().role, 'writer')
    assert.equal(runtime.reader.snapshot().role, 'reader')
  } finally {
    await runtime.dispose()
  }
})

test('remote Storage transaction commits atomically and rolls back on failure', async () => {
  const runtime = await fixture()
  try {
    await runtime.storage.transaction(async tx => {
      await tx.hosts.put(host('committed'))
    })
    assert.equal((await runtime.storage.repositories.hosts.get('committed'))?.id, 'committed')

    await assert.rejects(runtime.storage.transaction(async tx => {
      await tx.hosts.put(host('rolled-back'))
      assert.equal((await tx.hosts.get('rolled-back'))?.id, 'rolled-back')
      throw new Error('force rollback')
    }), /force rollback/)

    assert.equal(await runtime.storage.repositories.hosts.get('rolled-back'), null)
  } finally {
    await runtime.dispose()
  }
})

test('writer synchronous work does not block independent reader queries', async () => {
  const runtime = await fixture()
  try {
    await runtime.storage.repositories.hosts.put(host('reader-visible'))
    const blocking = runtime.writer.request<{ blockedMs: number }>(
      'diagnostic.block',
      { durationMs: 200 },
      1_000,
    )

    const startedAt = performance.now()
    const visible = await runtime.storage.repositories.hosts.get('reader-visible')
    const readerDuration = performance.now() - startedAt

    assert.equal(visible?.id, 'reader-visible')
    assert.ok(readerDuration < 150, `reader blocked for ${readerDuration.toFixed(1)}ms`)
    assert.equal((await blocking).blockedMs, 200)
  } finally {
    await runtime.dispose()
  }
})
