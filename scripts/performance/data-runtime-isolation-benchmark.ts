import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataRuntimeClient } from '../../apps/daemon/src/data-runtime/client'
import { createDataRuntimeStorage } from '../../apps/daemon/src/data-runtime/storage-proxy'

const root = await mkdtemp(join(tmpdir(), 'agent-lens-data-runtime-perf-'))
const dbPath = join(root, 'agent-lens.db')
const writer = new DataRuntimeClient({
  role: 'writer',
  dbPath,
  nodeId: 'perf-node',
  allowDiagnostics: true,
  requestTimeoutMs: 5_000,
})
const reader = new DataRuntimeClient({
  role: 'reader',
  dbPath,
  nodeId: 'perf-node',
  allowDiagnostics: true,
  requestTimeoutMs: 5_000,
})

try {
  await writer.start()
  await reader.start()
  const runtime = createDataRuntimeStorage(writer, reader)
  await runtime.storage.repositories.hosts.put({
    id: 'perf-host',
    name: 'perf-host',
    platform: process.platform,
    arch: process.arch,
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  })

  const samples: number[] = []
  for (let index = 0; index < 20; index += 1) {
    const blocking = writer.request('diagnostic.block', { durationMs: 100 }, 1_000)
    const startedAt = performance.now()
    const value = await runtime.storage.repositories.hosts.get('perf-host')
    samples.push(performance.now() - startedAt)
    if (!value) throw new Error('reader lost committed data')
    await blocking
  }

  samples.sort((a, b) => a - b)
  const percentile = (ratio: number) => samples[Math.ceil(samples.length * ratio) - 1] ?? 0
  const report = {
    samples: samples.length,
    readerWhileWriterBlockedMs: {
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      max: samples.at(-1) ?? 0,
    },
    writer: writer.snapshot(),
    reader: reader.snapshot(),
  }
  console.log(JSON.stringify(report, null, 2))

  if (report.readerWhileWriterBlockedMs.p95 >= 100) {
    throw new Error(`Data Runtime reader isolation regression: p95=${report.readerWhileWriterBlockedMs.p95.toFixed(1)}ms`)
  }

  await runtime.dataRuntime.shutdown()
} finally {
  await reader.shutdown().catch(() => undefined)
  await writer.shutdown().catch(() => undefined)
  await rm(root, { recursive: true, force: true })
}
