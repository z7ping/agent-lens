import { performance } from 'node:perf_hooks'

const DEFAULT_BASE_URL = 'http://127.0.0.1:56789'
const DEFAULT_SAMPLES = 20
const DEFAULT_WARMUP = 3
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_TOOLS_BURST = 64
const DEFAULT_MIXED_BURST = 128
const HEALTH_REFRESH_MS = 1_100
const TOOLS_RESULT_CACHE_REFRESH_MS = 2_100

function arg(name, fallback) {
  const prefix = `--${name}=`
  const raw = process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length)
  return raw === undefined ? fallback : raw
}

function positiveInt(name, fallback) {
  const value = Number.parseInt(arg(name, String(fallback)), 10)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function nonNegativeInt(name, fallback) {
  const value = Number.parseInt(arg(name, String(fallback)), 10)
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

function percentile(values, ratio) {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index] ?? 0
}

function rounded(value) {
  return Number(value.toFixed(2))
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const options = {
  baseUrl: arg('base-url', process.env.AGENT_LENS_ACCEPT_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, ''),
  samples: positiveInt('samples', DEFAULT_SAMPLES),
  warmup: nonNegativeInt('warmup', DEFAULT_WARMUP),
  timeoutMs: positiveInt('timeout-ms', DEFAULT_TIMEOUT_MS),
  toolsBurst: nonNegativeInt('tools-burst', DEFAULT_TOOLS_BURST),
  burst: nonNegativeInt('burst', DEFAULT_MIXED_BURST),
}

const probes = [
  { id: 'ready', label: '/ready', path: '/api/v1/ready', p95BudgetMs: 100, acceptedStatuses: new Set([200]) },
  { id: 'health', label: '/health', path: '/api/v1/health', p95BudgetMs: 500, acceptedStatuses: new Set([200, 503]) },
  { id: 'piAvailability', label: 'Pi availability', path: '/api/v1/pi-live/availability', p95BudgetMs: 100, acceptedStatuses: new Set([200]) },
  { id: 'taskCenter', label: 'Task Center first page', path: '/api/v1/review?limit=20', p95BudgetMs: 500, acceptedStatuses: new Set([200]) },
  { id: 'facets', label: 'facets', path: '/api/v1/facets', p95BudgetMs: 500, acceptedStatuses: new Set([200]) },
  { id: 'tools', label: 'Tools summary', path: '/api/v1/usage?limit=500', p95BudgetMs: 1_000, acceptedStatuses: new Set([200]) },
  { id: 'agents', label: 'Agent overview', path: '/api/v1/agents', p95BudgetMs: 1_000, acceptedStatuses: new Set([200]) },
]

const toolsProbe = probes.find(probe => probe.id === 'tools')
if (!toolsProbe) throw new Error('Tools acceptance probe is missing')
const mixedForegroundProbes = probes.filter(probe => ['taskCenter', 'facets', 'tools', 'agents'].includes(probe.id))

async function request(path, acceptedStatuses) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  timer.unref?.()
  const startedAt = performance.now()
  try {
    const response = await fetch(`${options.baseUrl}${path}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    const elapsedMs = performance.now() - startedAt
    const accepted = acceptedStatuses.has(response.status)
    let body = null
    try { body = await response.json() } catch { /* body is diagnostic only */ }
    return { ok: accepted, status: response.status, elapsedMs, body }
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

async function measureProbe(probe) {
  for (let index = 0; index < options.warmup; index += 1) await request(probe.path, probe.acceptedStatuses)

  const samples = []
  let failures = 0
  const statuses = new Map()
  let lastBody = null
  for (let index = 0; index < options.samples; index += 1) {
    const result = await request(probe.path, probe.acceptedStatuses)
    samples.push(result.elapsedMs)
    statuses.set(result.status, (statuses.get(result.status) ?? 0) + 1)
    if (!result.ok) failures += 1
    if (result.body !== undefined) lastBody = result.body
  }

  const p50Ms = percentile(samples, 0.50)
  const p95Ms = percentile(samples, 0.95)
  const p99Ms = percentile(samples, 0.99)
  const failureRate = samples.length ? failures / samples.length : 1
  return {
    id: probe.id,
    label: probe.label,
    path: probe.path,
    budget: { p95Ms: probe.p95BudgetMs, maxFailureRate: 0 },
    result: {
      count: samples.length,
      p50Ms: rounded(p50Ms),
      p95Ms: rounded(p95Ms),
      p99Ms: rounded(p99Ms),
      maxMs: rounded(Math.max(...samples)),
      failures,
      failureRate: rounded(failureRate),
      statuses: Object.fromEntries([...statuses.entries()].map(([status, count]) => [String(status), count])),
    },
    passed: failures === 0 && p95Ms <= probe.p95BudgetMs,
    lastBody,
  }
}

async function runBurst(count, burstProbes) {
  if (count <= 0) return null
  if (!burstProbes.length) throw new Error('burst probes must not be empty')

  const startedAt = performance.now()
  const jobs = Array.from({ length: count }, (_, index) => {
    const probe = burstProbes[index % burstProbes.length]
    return request(probe.path, probe.acceptedStatuses).then(result => ({ probe: probe.id, ...result }))
  })
  const results = await Promise.all(jobs)
  const failures = results.filter(result => !result.ok)
  const elapsedMs = performance.now() - startedAt
  const durations = results.map(result => result.elapsedMs)
  return {
    count,
    elapsedMs: rounded(elapsedMs),
    p50Ms: rounded(percentile(durations, 0.50)),
    p95Ms: rounded(percentile(durations, 0.95)),
    p99Ms: rounded(percentile(durations, 0.99)),
    maxMs: rounded(Math.max(...durations)),
    failures: failures.length,
    failureRate: rounded(failures.length / count),
    statuses: Object.fromEntries(
      [...results.reduce((map, result) => {
        const key = `${result.probe}:${result.status}`
        map.set(key, (map.get(key) ?? 0) + 1)
        return map
      }, new Map()).entries()],
    ),
    errors: failures.slice(0, 10).map(result => ({
      probe: result.probe,
      status: result.status,
      message: result.body?.message ?? result.error ?? null,
    })),
    passed: failures.length === 0,
  }
}

function projectionStatus(usage) {
  const value = usage?.meta?.projection
  if (!value || typeof value !== 'object') return null
  return {
    state: value.state,
    sourceObservationCount: Number(value.sourceObservationCount ?? 0),
    projectedCount: Number(value.projectedCount ?? 0),
    missingCount: Number(value.missingCount ?? 0),
    coverageRatio: Number(value.coverageRatio ?? 0),
  }
}

console.log('AgentLens large DB runtime acceptance')
console.log(JSON.stringify({ options, budgets: Object.fromEntries(probes.map(probe => [probe.id, { p95Ms: probe.p95BudgetMs, maxFailureRate: 0 }])) }, null, 2))

const measurements = []
for (const probe of probes) {
  process.stdout.write(`measuring ${probe.label} ... `)
  const result = await measureProbe(probe)
  measurements.push(result)
  console.log(`${result.passed ? 'PASS' : 'FAIL'} p95=${result.result.p95Ms}ms failures=${result.result.failures}/${result.result.count}`)
}

// The single-request probe above warms the short Tools aggregate cache. The
// concurrency gates must start after that cache expires, otherwise a hot cache
// could hide a broken same-key single-flight implementation.
let toolsBurst = null
if (options.toolsBurst > 0) {
  await delay(TOOLS_RESULT_CACHE_REFRESH_MS)
  toolsBurst = await runBurst(options.toolsBurst, [toolsProbe])
  console.log(`cold Tools burst ${toolsBurst.passed ? 'PASS' : 'FAIL'} failures=${toolsBurst.failures}/${toolsBurst.count} p95=${toolsBurst.p95Ms}ms elapsed=${toolsBurst.elapsedMs}ms`)
}

let burst = null
if (options.burst > 0) {
  // A successful Tools-only burst also warms the same aggregate cache. Expire
  // it again so mixed128 independently exercises cold shared-Reader admission.
  await delay(TOOLS_RESULT_CACHE_REFRESH_MS)
  burst = await runBurst(options.burst, mixedForegroundProbes)
  console.log(`cold mixed foreground burst ${burst.passed ? 'PASS' : 'FAIL'} failures=${burst.failures}/${burst.count} p95=${burst.p95Ms}ms elapsed=${burst.elapsedMs}ms`)
}

// HTTP health and Tool projection readiness both have short caches. Wait past
// those TTLs, then explicitly refresh both final-state snapshots after bursts.
if (toolsBurst || burst) await delay(HEALTH_REFRESH_MS)
const [freshHealthResult, freshUsageResult] = await Promise.all([
  request('/api/v1/health', new Set([200, 503])),
  request('/api/v1/usage?limit=1', new Set([200])),
])
const health = freshHealthResult.body
const toolUsageProjection = projectionStatus(freshUsageResult.body)
const projectionReady = Boolean(
  freshUsageResult.ok
  && toolUsageProjection
  && toolUsageProjection.state === 'ready'
  && toolUsageProjection.missingCount === 0
  && toolUsageProjection.coverageRatio >= 1,
)

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl: options.baseUrl,
  measurements: measurements.map(({ lastBody: _lastBody, ...measurement }) => measurement),
  ...(toolsBurst ? { toolsBurst } : {}),
  ...(burst ? { burst } : {}),
  projectionReadiness: {
    passed: projectionReady,
    toolUsageFacts: toolUsageProjection,
  },
  health: health && typeof health === 'object' ? {
    status: health.status,
    dataRuntime: health.dataRuntime ?? health.storage?.details?.dataRuntime ?? null,
    eventLoop: health.storage?.details?.eventLoop ?? null,
    capacity: health.storage?.details?.dataGrowth?.capacity ?? null,
    maintenanceGate: health.storage?.details?.maintenanceGate ?? null,
  } : null,
}
console.log(JSON.stringify(report, null, 2))

const failed = measurements.filter(item => !item.passed)
if (toolsBurst && !toolsBurst.passed) failed.push({ label: 'cold Tools burst' })
if (burst && !burst.passed) failed.push({ label: 'cold mixed foreground burst' })
if (!freshHealthResult.ok) failed.push({ label: 'fresh post-burst health' })
if (!freshUsageResult.ok || !projectionReady) failed.push({ label: 'Tool Fact projection readiness' })
if (failed.length) {
  console.error(`large DB acceptance failed: ${failed.map(item => item.label).join(', ')}`)
  process.exitCode = 1
} else {
  console.log('large DB acceptance passed')
}
