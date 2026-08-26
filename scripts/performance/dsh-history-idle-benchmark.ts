import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { ingestDshHistory } from '../../apps/daemon/src/sources/dsh'

function readPositiveInt(name: string, fallback: number): number {
  const prefix = `--${name}=`
  const raw = process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length)
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

const files = readPositiveInt('files', 500)
const eventsPerFile = readPositiveInt('events-per-file', 20)
const payloadBytes = readPositiveInt('payload-bytes', 2048)
const samples = readPositiveInt('samples', 5)

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))
  return sorted[index] ?? 0
}

const root = mkdtempSync(join(tmpdir(), 'agent-lens-dsh-idle-'))
const sessionsDir = join(root, 'sessions')
mkdirSync(sessionsDir, { recursive: true })
const padding = 'x'.repeat(payloadBytes)

for (let fileIndex = 0; fileIndex < files; fileIndex += 1) {
  const lines = [JSON.stringify({ sessionId: `session-${fileIndex}`, cwd: `/fixture/${fileIndex}`, createdAt: 1 })]
  for (let eventIndex = 0; eventIndex < eventsPerFile; eventIndex += 1) {
    lines.push(JSON.stringify({
      seq: eventIndex + 1,
      type: eventIndex % 2 === 0 ? 'user/message' : 'assistant/message',
      time: fileIndex * eventsPerFile + eventIndex + 1,
      data: { content: padding },
    }))
  }
  writeFileSync(join(sessionsDir, `session-${String(fileIndex).padStart(6, '0')}.jsonl`), `${lines.join('\n')}\n`)
}

const checkpoints = new Map<string, unknown>()
const ctx = {
  host: { id: 'host-perf', name: 'perf', platform: process.platform, arch: process.arch, createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() },
  installation: { id: 'dsh-perf', hostId: 'host-perf', productId: 'dsh', dataRoot: root, configRoot: root, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() },
  abortSignal: new AbortController().signal,
  checkpoint: {
    async get<T>(key: string): Promise<T | null> { return (checkpoints.get(key) as T | undefined) ?? null },
    async set<T>(key: string, value: T): Promise<void> { checkpoints.set(key, value) },
    async clear(key: string): Promise<void> { checkpoints.delete(key) },
  },
} as any

async function drain(): Promise<number> {
  let count = 0
  for await (const _record of ingestDshHistory(ctx)) count += 1
  return count
}

try {
  const initialStart = performance.now()
  const initialRecords = await drain()
  const initialMs = performance.now() - initialStart
  const expectedRecords = files * eventsPerFile
  if (initialRecords !== expectedRecords) throw new Error(`initial record mismatch: ${initialRecords} !== ${expectedRecords}`)

  const idleSamples: number[] = []
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now()
    const idleRecords = await drain()
    idleSamples.push(performance.now() - started)
    if (idleRecords !== 0) throw new Error(`idle scan emitted ${idleRecords} records`)
  }

  console.log(JSON.stringify({
    fixture: { files, eventsPerFile, payloadBytes, expectedRecords },
    initialMs: Number(initialMs.toFixed(2)),
    idle: {
      minMs: Number(Math.min(...idleSamples).toFixed(2)),
      p50Ms: Number(percentile(idleSamples, 0.5).toFixed(2)),
      p95Ms: Number(percentile(idleSamples, 0.95).toFixed(2)),
      maxMs: Number(Math.max(...idleSamples).toFixed(2)),
    },
  }, null, 2))
} finally {
  rmSync(root, { recursive: true, force: true })
}
