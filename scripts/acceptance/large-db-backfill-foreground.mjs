import { performance } from 'node:perf_hooks'

const baseUrl = (process.env.AGENT_LENS_ACCEPT_BASE_URL ?? 'http://127.0.0.1:56789').replace(/\/$/, '')
const durationMs = Number.parseInt(process.argv.find(arg => arg.startsWith('--duration-ms='))?.slice('--duration-ms='.length) ?? '30000', 10)
const intervalMs = Number.parseInt(process.argv.find(arg => arg.startsWith('--interval-ms='))?.slice('--interval-ms='.length) ?? '100', 10)
const timeoutMs = Number.parseInt(process.argv.find(arg => arg.startsWith('--timeout-ms='))?.slice('--timeout-ms='.length) ?? '3000', 10)

if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('duration-ms must be positive')
if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('interval-ms must be positive')
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeout-ms must be positive')

const foreground = [
  '/api/v1/review?limit=20',
  '/api/v1/facets',
  '/api/v1/usage?limit=500',
  '/api/v1/agents',
]

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function request(path) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  const startedAt = performance.now()
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    let body = null
    try { body = await response.json() } catch { /* diagnostics only */ }
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      elapsedMs: performance.now() - startedAt,
      body,
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      elapsedMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timer)
  }
}

function projection(body) {
  const value = body?.meta?.projection
  if (!value || typeof value !== 'object') return null
  return {
    state: value.state,
    sourceObservationCount: Number(value.sourceObservationCount ?? 0),
    projectedCount: Number(value.projectedCount ?? 0),
    missingCount: Number(value.missingCount ?? 0),
    coverageRatio: Number(value.coverageRatio ?? 0),
  }
}

const initialUsage = await request('/api/v1/usage?limit=1')
const initialProjection = projection(initialUsage.body)
if (!initialUsage.ok || !initialProjection) {
  console.error('cannot read Tool Fact projection readiness before backfill/foreground acceptance')
  process.exit(1)
}

if (initialProjection.state === 'ready') {
  console.log(JSON.stringify({
    passed: true,
    skipped: true,
    reason: 'Tool Fact projection is already ready; run this acceptance against an incomplete large-DB copy to validate active backfill coexistence.',
    projection: initialProjection,
  }, null, 2))
  process.exit(0)
}

const startedAt = performance.now()
const samples = []
let failures = 0
let rounds = 0
let latestProjection = initialProjection

while (performance.now() - startedAt < durationMs) {
  rounds += 1
  const results = await Promise.all(foreground.map(path => request(path).then(result => ({ path, ...result }))))
  for (const result of results) {
    samples.push(result.elapsedMs)
    if (!result.ok) {
      failures += 1
      console.error(`foreground failure ${result.path}: status=${result.status} ${result.body?.message ?? result.error ?? ''}`)
    }
    if (result.path.startsWith('/api/v1/usage')) {
      latestProjection = projection(result.body) ?? latestProjection
    }
  }
  await delay(intervalMs)
}

// Projection status is cached for one second. Fetch a final fresh sample.
await delay(1100)
const finalUsage = await request('/api/v1/usage?limit=1')
const finalProjection = projection(finalUsage.body) ?? latestProjection
const progressed = finalProjection.projectedCount > initialProjection.projectedCount
const nonRegressing = finalProjection.projectedCount >= initialProjection.projectedCount
const p95 = samples.length
  ? [...samples].sort((a, b) => a - b)[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)]
  : 0
const passed = failures === 0 && finalUsage.ok && nonRegressing && progressed

console.log(JSON.stringify({
  passed,
  durationMs,
  rounds,
  requests: samples.length,
  failures,
  foregroundP95Ms: Number(p95.toFixed(2)),
  initialProjection,
  finalProjection,
  progressed,
}, null, 2))

if (!passed) {
  if (!progressed) console.error('Tool Fact backfill made no observable progress during the foreground coexistence window')
  process.exitCode = 1
}
