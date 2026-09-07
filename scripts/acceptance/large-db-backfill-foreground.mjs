import { performance } from 'node:perf_hooks'

const baseUrl = (process.env.AGENT_LENS_ACCEPT_BASE_URL ?? 'http://127.0.0.1:56789').replace(/\/$/, '')
const durationMs = Number.parseInt(process.argv.find(arg => arg.startsWith('--duration-ms='))?.slice('--duration-ms='.length) ?? '30000', 10)
const intervalMs = Number.parseInt(process.argv.find(arg => arg.startsWith('--interval-ms='))?.slice('--interval-ms='.length) ?? '100', 10)
const timeoutMs = Number.parseInt(process.argv.find(arg => arg.startsWith('--timeout-ms='))?.slice('--timeout-ms='.length) ?? '3000', 10)
const foregroundP95BudgetMs = Number.parseInt(process.argv.find(arg => arg.startsWith('--foreground-p95-budget-ms='))?.slice('--foreground-p95-budget-ms='.length) ?? '1000', 10)
const activationTimeoutMs = Number.parseInt(process.argv.find(arg => arg.startsWith('--activation-timeout-ms='))?.slice('--activation-timeout-ms='.length) ?? '120000', 10)

if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('duration-ms must be positive')
if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('interval-ms must be positive')
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeout-ms must be positive')
if (!Number.isFinite(foregroundP95BudgetMs) || foregroundP95BudgetMs <= 0) throw new Error('foreground-p95-budget-ms must be positive')
if (!Number.isFinite(activationTimeoutMs) || activationTimeoutMs <= 0) throw new Error('activation-timeout-ms must be positive')

const foreground = [
  '/api/v1/review?limit=20',
  '/api/v1/facets',
  '/api/v1/usage?limit=500',
  '/api/v1/agents',
]
const HEALTH_STATUSES = new Set([200, 503])

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function request(path, acceptedStatuses) {
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
    const ok = acceptedStatuses
      ? acceptedStatuses.has(response.status)
      : response.status >= 200 && response.status < 300
    return {
      ok,
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

function maintenanceGate(body) {
  const value = body?.storage?.details?.maintenanceGate
  if (!value || typeof value !== 'object') return null
  const permits = value.permits
  const policy = value.policy
  return {
    activeRequests: Number(value.activeRequests ?? 0),
    load: value.load ?? null,
    policy: policy && typeof policy === 'object' ? {
      quietMs: Number(policy.quietMs ?? 0),
      pollMs: Number(policy.pollMs ?? 0),
      maxDeferMs: Number(policy.maxDeferMs ?? 0),
    } : null,
    permits: permits && typeof permits === 'object' ? {
      quiet: Number(permits.quiet ?? 0),
      forced: Number(permits.forced ?? 0),
      maxWaitMs: Number(permits.maxWaitMs ?? 0),
    } : null,
  }
}

async function freshSnapshot() {
  // Usage aggregate has a 2s cache. Health is stale-while-revalidate, so the
  // first expired read starts refresh and the second read observes it.
  await delay(2100)
  await Promise.all([
    request('/api/v1/usage?limit=1'),
    request('/api/v1/health', HEALTH_STATUSES),
  ])
  await delay(200)
  const [usage, health] = await Promise.all([
    request('/api/v1/usage?limit=1'),
    request('/api/v1/health', HEALTH_STATUSES),
  ])
  return { usage, health, projection: projection(usage.body), gate: maintenanceGate(health.body) }
}

let initial = await freshSnapshot()
const activationStartedAt = performance.now()
const activationBaseline = initial.projection?.projectedCount ?? 0
while (initial.projection?.state !== 'ready'
  && initial.projection?.projectedCount === activationBaseline
  && performance.now() - activationStartedAt < activationTimeoutMs) {
  initial = await freshSnapshot()
}
const activationMs = Math.round(performance.now() - activationStartedAt)

const initialUsage = initial.usage
const initialHealth = initial.health
const initialProjection = initial.projection
const initialGate = initial.gate
if (!initialUsage.ok || !initialProjection) {
  console.error('cannot read Tool Fact projection readiness before backfill/foreground acceptance')
  process.exit(1)
}
if (!initialHealth.ok || !initialGate?.permits) {
  console.error('cannot read maintenance fairness metrics before backfill/foreground acceptance')
  process.exit(1)
}

if (initialProjection.state === 'ready') {
  console.log(JSON.stringify({
    passed: false,
    skipped: true,
    verified: false,
    reason: 'Tool Fact projection is already ready; this run did not exercise active backfill + foreground coexistence. Use an incomplete large-DB copy for this acceptance.',
    projection: initialProjection,
    maintenanceGate: initialGate,
  }, null, 2))
  process.exit(0)
}
if (initialProjection.projectedCount === activationBaseline) {
  console.error(`Tool Fact backfill did not become active within ${activationTimeoutMs}ms`)
  process.exit(1)
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

const final = await freshSnapshot()
const finalUsage = final.usage
const finalHealth = final.health
const finalProjection = final.projection ?? latestProjection
const finalGate = final.gate
const progressed = finalProjection.projectedCount > initialProjection.projectedCount
const nonRegressing = finalProjection.projectedCount >= initialProjection.projectedCount
const forcedPermitsDelta = (finalGate?.permits?.forced ?? 0) - initialGate.permits.forced
const fairnessObserved = forcedPermitsDelta > 0
const p95 = samples.length
  ? [...samples].sort((a, b) => a - b)[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)]
  : 0
const foregroundLatencyPassed = p95 <= foregroundP95BudgetMs
const passed = failures === 0
  && finalUsage.ok
  && finalHealth.ok
  && nonRegressing
  && progressed
  && fairnessObserved
  && foregroundLatencyPassed

console.log(JSON.stringify({
  passed,
  skipped: false,
  verified: passed,
  durationMs,
  activationMs,
  rounds,
  requests: samples.length,
  failures,
  foregroundP95Ms: Number(p95.toFixed(2)),
  foregroundP95BudgetMs,
  foregroundLatencyPassed,
  initialProjection,
  finalProjection,
  progressed,
  maintenanceFairness: {
    observed: fairnessObserved,
    forcedPermitsDelta,
    initial: initialGate,
    final: finalGate,
  },
}, null, 2))

if (!passed) {
  if (!progressed) console.error('Tool Fact backfill made no observable progress during the foreground coexistence window')
  if (!fairnessObserved) console.error('maintenance gate did not record any forced permit during sustained foreground traffic')
  if (!foregroundLatencyPassed) console.error(`foreground P95 ${p95.toFixed(2)}ms exceeds ${foregroundP95BudgetMs}ms budget during maintenance coexistence`)
  process.exitCode = 1
}
