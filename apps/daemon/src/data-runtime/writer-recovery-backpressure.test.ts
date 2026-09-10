import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DataRuntimeClient } from './client'
import { createDataRuntimeStorage } from './storage-proxy'

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Data Runtime state')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const host = (id: string) => ({
  id,
  name: id,
  platform: 'linux',
  arch: 'x64',
  createdAt: '2026-09-10T00:00:00.000Z',
  lastSeenAt: '2026-09-10T00:00:00.000Z',
})

test('storage write waits for transient writer recovery instead of failing immediately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-writer-recovery-'))
  const dbPath = join(root, 'agent-lens.db')
  const common = {
    dbPath,
    nodeId: 'node-writer-recovery',
    allowDiagnostics: true,
    requestTimeoutMs: 5_000,
    heartbeatIntervalMs: 60_000,
  }
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
  runtime.dataRuntime.startRecovery(500)

  try {
    await runtime.storage.repositories.hosts.put(host('before-recovery'))
    await writer.request('diagnostic.exit').catch(() => undefined)
    await waitFor(() => writer.state() === 'degraded')

    const writeDuringRecovery = runtime.storage.repositories.hosts.put(host('during-recovery'))
    const earlyState = await Promise.race([
      writeDuringRecovery.then(() => 'resolved', () => 'rejected'),
      new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 75)),
    ])
    assert.equal(earlyState, 'pending')

    await writeDuringRecovery
    assert.equal(writer.state(), 'ready')
    assert.equal(
      (await runtime.storage.repositories.hosts.get('during-recovery'))?.id,
      'during-recovery',
    )
  } finally {
    await runtime.dataRuntime.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})
