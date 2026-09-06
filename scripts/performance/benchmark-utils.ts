import { statSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

export interface BenchmarkTiming {
  name: string
  minMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
}

export function readPositiveInt(name: string, fallback: number): number {
  const prefix = `--${name}=`
  const raw = process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length)
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

export function readOptionalPositiveInt(name: string): number | null {
  const prefix = `--${name}=`
  const raw = process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length)
  if (!raw) return null
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

export function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index] ?? 0
}

export async function measure(
  name: string,
  samples: number,
  run: () => Promise<unknown>,
): Promise<BenchmarkTiming> {
  await run()
  const durations: number[] = []
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now()
    await run()
    durations.push(performance.now() - started)
  }
  return {
    name,
    minMs: Number(Math.min(...durations).toFixed(2)),
    p50Ms: Number(percentile(durations, 0.50).toFixed(2)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(2)),
    maxMs: Number(Math.max(...durations).toFixed(2)),
  }
}

export function fileSize(path: string): number {
  try { return statSync(path).size } catch { return 0 }
}

export function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1)
}
