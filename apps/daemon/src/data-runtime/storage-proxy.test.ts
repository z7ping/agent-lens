import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DataRuntimeClient } from './client'
import {
  createDataRuntimeStorage,
  DataRuntimeReaderPool,
  dataRuntimeStorageInternals,
} from './storage-proxy'

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Data Runtime state')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-data-runtime-'))
  const dbPath = join(root, 'agent-lens.db')
  const common = { dbPath, nodeId: 'node-test', allowDiagnostics: true, requestTimeoutMs: 5_000 }
  const writer = new DataRuntimeClient({ ...common, role: 'writer' })
  const readers = [
    new DataRuntimeClient({ ...common, role: 'reader' }),
    new DataRuntimeClient({ ...common, role: 'reader' }),
  ]
  const maintenanceReader = new DataRuntimeClient({ ...common, role: 'reader' })
  await writer.start()
  for (const reader of readers) await reader.start()
  await maintenanceReader.start()
  const runtime = createDataRuntimeStorage(writer, readers, maintenanceReader)
  return {
    root,
    writer,
    readers,
    reader: readers[0]!,
    maintenanceReader,
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

test('Data Runtime routes analytics reads to foreground pool and maintenance scans separately', () => {
  assert.equal(dataRuntimeStorageInternals.READ_TIMEOUT_MS, 2_000)
  assert.equal(dataRuntimeStorageInternals.isReadPath(['toolUsageObservations', 'aggregate']), true)
  assert.equal(dataRuntimeStorageInternals.isMaintenanceReadPath(['repositories', 'sourceRecords', 'listForParserReplay']), true)
  assert.equal(dataRuntimeStorageInternals.isMaintenanceReadPath(['diagnostics']), true)
  assert.equal(dataRuntimeStorageInternals.isMaintenanceReadPath(['sessionSummaryProjection', 'query']), false)
})

test('foreground reader pool prefers the least-loaded ready reader', async () => {
  const left = new DataRuntimeClient({ role: 'reader', allowDiagnostics: true, heartbeatIntervalMs: 60_000 })
  const right = new DataRuntimeClient({ role: 'reader', allowDiagnostics: true, heartbeatIntervalMs: 60_000 })
  await left.start()
  await right.start()
  const pool = new DataRuntimeReaderPool([left, right])
  try {
    const blocking = left.request('diagnostic.block', { durationMs: 150 }, 1_000)
    await new Promise(resolve => setTimeout(resolve, 10))
    const startedAt = performance.now()
    await pool.request('ping', {}, 1_000)
    assert.ok(performance.now() - startedAt < 100)
    await blocking
  } finally {
    await left.shutdown()
    await right.shutdown()
  }
})

test('foreground reader pool fails fast at bounded saturation without recycling readers', async () => {
  const left = new DataRuntimeClient({ role: 'reader', allowDiagnostics: true, heartbeatIntervalMs: 60_000 })
  const right = new DataRuntimeClient({ role: 'reader', allowDiagnostics: true, heartbeatIntervalMs: 60_000 })
  await left.start()
  await right.start()
  const pool = new DataRuntimeReaderPool([left, right])
  try {
    const blockers = [
      left.request('diagnostic.block', { durationMs: 500 }, 1_000),
      right.request('diagnostic.block', { durationMs: 500 }, 1_000),
    ]
    await new Promise(resolve => setTimeout(resolve, 20))

    const queued = Array.from({ length: 126 }, () => pool.request('ping', {}, 1_000))
    assert.equal(pool.pending(), 128)

    const startedAt = performance.now()
    await assert.rejects(pool.request('ping', {}, 1_000), /pending request limit reached/)
    assert.ok(performance.now() - startedAt < 100)
    assert.equal(left.state(), 'ready')
    assert.equal(right.state(), 'ready')
    assert.equal(left.snapshot().livenessFailures, 0)
    assert.equal(right.snapshot().livenessFailures, 0)

    await Promise.all([...blockers, ...queued])
    assert.equal(pool.pending(), 0)
    assert.equal(left.state(), 'ready')
    assert.equal(right.state(), 'ready')
  } finally {
    await left.shutdown()
    await right.shutdown()
  }
})

test('Data Runtime uses writer for mutations and foreground readers for committed reads', async () => {
  const runtime = await fixture()
  try {
    await runtime.storage.repositories.hosts.put(host('host-1'))
    assert.equal((await runtime.storage.repositories.hosts.get('host-1'))?.name, 'host-1')
    assert.equal(runtime.writer.snapshot().role, 'writer')
    assert.equal(runtime.dataRuntime.snapshot().readers.length, 2)
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

test('writer synchronous work does not block independent foreground reader queries', async () => {
  const runtime = await fixture()
  try {
    await runtime.storage.repositories.hosts.put(host('reader-visible'))
    const blocking = runtime.writer.request<{ blockedMs: number }>('diagnostic.block', { durationMs: 200 }, 1_000)
    const startedAt = performance.now()
    const visible = await runtime.storage.repositories.hosts.get('reader-visible')
    assert.equal(visible?.id, 'reader-visible')
    assert.ok(performance.now() - startedAt < 180)
    assert.equal((await blocking).blockedMs, 200)
  } finally {
    await runtime.dispose()
  }
})

test('one foreground reader crash keeps pool available and recovers without restarting writer', async () => {
  const runtime = await fixture()
  try {
    await runtime.storage.repositories.hosts.put(host('survives-reader-crash'))
    const writerBefore = await runtime.writer.request<{ threadId: number }>('status')
    runtime.dataRuntime.startRecovery(50)

    await runtime.readers[0]!.request('diagnostic.exit')
    await waitFor(() => runtime.readers[0]!.state() === 'degraded')
    assert.equal(runtime.writer.state(), 'ready')
    assert.equal(runtime.readers[1]!.state(), 'ready')
    assert.equal(runtime.dataRuntime.snapshot().ok, true)
    assert.equal((await runtime.storage.repositories.hosts.get('survives-reader-crash'))?.id, 'survives-reader-crash')

    await waitFor(() => runtime.readers[0]!.state() === 'ready')
    const writerAfter = await runtime.writer.request<{ threadId: number }>('status')
    assert.equal(writerAfter.threadId, writerBefore.threadId)
  } finally {
    await runtime.dispose()
  }
})

test('writer worker crash keeps foreground readers online and recovers write ownership', async () => {
  const runtime = await fixture()
  try {
    await runtime.storage.repositories.hosts.put(host('before-writer-crash'))
    const readerBefore = await runtime.readers[0]!.request<{ threadId: number }>('status')
    runtime.dataRuntime.startRecovery(50)

    await runtime.writer.request('diagnostic.exit')
    await waitFor(() => runtime.writer.state() === 'degraded')
    assert.equal(runtime.readers[0]!.state(), 'ready')
    assert.equal((await runtime.storage.repositories.hosts.get('before-writer-crash'))?.id, 'before-writer-crash')
    assert.equal(runtime.dataRuntime.snapshot().ok, false)

    await waitFor(() => runtime.writer.state() === 'ready')
    const readerAfter = await runtime.readers[0]!.request<{ threadId: number }>('status')
    assert.equal(readerAfter.threadId, readerBefore.threadId)
    await runtime.storage.repositories.hosts.put(host('after-writer-recovery'))
    assert.equal((await runtime.storage.repositories.hosts.get('after-writer-recovery'))?.id, 'after-writer-recovery')
    assert.equal(runtime.dataRuntime.snapshot().ok, true)
  } finally {
    await runtime.dispose()
  }
})
