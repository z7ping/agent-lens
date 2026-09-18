import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { SourceHistoryExecutionContext } from '../../packages/core/src/index'
import { ingestPiHistory, type PiHistoryScanDiagnostics } from '../../packages/source-pi/src/session'
import { percentile, readPositiveInt } from './benchmark-utils'

const files = readPositiveInt('files', 500)
const recordsPerFile = readPositiveInt('records-per-file', 20)
const payloadBytes = readPositiveInt('payload-bytes', 2048)
const samples = readPositiveInt('samples', 5)

const root = mkdtempSync(join(tmpdir(), 'agent-lens-pi-idle-'))
const sessionsDir = join(root, 'sessions')
mkdirSync(sessionsDir, { recursive: true })
const padding = 'x'.repeat(payloadBytes)

for (let fileIndex = 0; fileIndex < files; fileIndex += 1) {
  const lines = [JSON.stringify({ type: 'session', id: `session-${fileIndex}`, cwd: `/fixture/${fileIndex}`, version: 'perf' })]
  for (let recordIndex = 0; recordIndex < recordsPerFile; recordIndex += 1) {
    lines.push(JSON.stringify({
      type: 'message',
      id: `message-${fileIndex}-${recordIndex}`,
      timestamp: new Date(Date.UTC(2026, 7, 1) + (fileIndex * recordsPerFile + recordIndex) * 1000).toISOString(),
      message: { role: 'assistant', content: padding },
    }))
  }
  writeFileSync(join(sessionsDir, `session-${String(fileIndex).padStart(6, '0')}.jsonl`), `${lines.join('\n')}\n`)
}

const checkpoints = new Map<string, unknown>()
const observedAt = new Date().toISOString()
const ctx: SourceHistoryExecutionContext = {
  host: {
    id: 'host-perf',
    name: 'perf',
    platform: process.platform,
    arch: process.arch,
    createdAt: observedAt,
    lastSeenAt: observedAt,
  },
  installation: {
    id: 'pi-perf',
    hostId: 'host-perf',
    productId: 'pi',
    dataRoot: sessionsDir,
    configRoot: root,
    firstSeenAt: observedAt,
    lastSeenAt: observedAt,
  },
  abortSignal: new AbortController().signal,
  checkpoint: {
    async get<T>(key: string): Promise<T | null> { return (checkpoints.get(key) as T | undefined) ?? null },
    async set<T>(key: string, value: T): Promise<void> { checkpoints.set(key, value) },
    async clear(key: string): Promise<void> { checkpoints.delete(key) },
  },
}

const scanDiagnostics: PiHistoryScanDiagnostics[] = []
const originalDebug = console.debug
console.debug = (...args: unknown[]) => {
  if (
    args[0] === '[AgentLens] Pi history scan'
    && args[1]
    && typeof args[1] === 'object'
    && !Array.isArray(args[1])
  ) {
    const value = args[1] as PiHistoryScanDiagnostics
    scanDiagnostics.push({
      enumeratedFiles: value.enumeratedFiles,
      statFiles: value.statFiles,
      unchangedFiles: value.unchangedFiles,
      changedFiles: value.changedFiles,
      parsedFiles: value.parsedFiles,
      bytesRead: value.bytesRead,
    })
  }
  originalDebug(...args)
}

async function drain(): Promise<{ records: number; diagnostics: PiHistoryScanDiagnostics }> {
  const before = scanDiagnostics.length
  let records = 0
  for await (const _record of ingestPiHistory(ctx)) records += 1
  const diagnostics = scanDiagnostics.at(-1)
  if (!diagnostics || scanDiagnostics.length === before) throw new Error('Pi scan diagnostics were not emitted')
  return { records, diagnostics }
}

try {
  const initialStart = performance.now()
  const initial = await drain()
  const initialMs = performance.now() - initialStart
  const expectedRecords = files * (recordsPerFile + 1)
  if (initial.records !== expectedRecords) throw new Error(`initial record mismatch: ${initial.records} !== ${expectedRecords}`)

  const idleSamples: number[] = []
  let lastIdleDiagnostics: PiHistoryScanDiagnostics | null = null
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now()
    const idle = await drain()
    idleSamples.push(performance.now() - started)
    lastIdleDiagnostics = idle.diagnostics
    if (idle.records !== 0) throw new Error(`idle scan emitted ${idle.records} records`)
    if (idle.diagnostics.parsedFiles !== 0 || idle.diagnostics.changedFiles !== 0 || idle.diagnostics.bytesRead !== 0) {
      throw new Error(`idle scan re-read unchanged content: ${JSON.stringify(idle.diagnostics)}`)
    }
    if (idle.diagnostics.unchangedFiles !== files) {
      throw new Error(`idle scan did not reuse every unchanged file: ${JSON.stringify(idle.diagnostics)}`)
    }
  }

  const changedPath = join(sessionsDir, 'session-000000.jsonl')
  appendFileSync(changedPath, `${JSON.stringify({
    type: 'message',
    id: 'message-appended-after-idle',
    timestamp: new Date(Date.UTC(2026, 7, 2)).toISOString(),
    message: { role: 'assistant', content: 'incremental' },
  })}\n`)
  const incremental = await drain()
  if (incremental.records !== 1) throw new Error(`incremental append emitted ${incremental.records} records instead of 1`)
  if (incremental.diagnostics.changedFiles !== 1 || incremental.diagnostics.parsedFiles !== 1) {
    throw new Error(`incremental scan touched more than one changed file: ${JSON.stringify(incremental.diagnostics)}`)
  }
  if (incremental.diagnostics.unchangedFiles !== files - 1 || incremental.diagnostics.bytesRead <= 0) {
    throw new Error(`incremental scan did not reuse unchanged files: ${JSON.stringify(incremental.diagnostics)}`)
  }

  console.log(JSON.stringify({
    fixture: { files, recordsPerFile, payloadBytes, expectedRecords },
    initialMs: Number(initialMs.toFixed(2)),
    idleDiagnostics: lastIdleDiagnostics,
    incrementalDiagnostics: incremental.diagnostics,
    idle: {
      minMs: Number(Math.min(...idleSamples).toFixed(2)),
      p50Ms: Number(percentile(idleSamples, 0.5).toFixed(2)),
      p95Ms: Number(percentile(idleSamples, 0.95).toFixed(2)),
      maxMs: Number(Math.max(...idleSamples).toFixed(2)),
    },
  }, null, 2))
} finally {
  console.debug = originalDebug
  rmSync(root, { recursive: true, force: true })
}
