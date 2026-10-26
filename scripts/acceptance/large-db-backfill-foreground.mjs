import { performance } from 'node:perf_hooks'
import { nativeCatalogPath, nativeMetricsPath, nativeMetricSnapshot, readNativeCatalog } from './native-acceptance.mjs'

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
  `${nativeCatalogPath}?limit=20`,
  nativeMetricsPath,
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

// 读取原生索引和按需指标重建结果；不再等待已退役的 Tool Fact 投影或维护许可。
async function snapshot() {
  const [metrics, health] = await Promise.all([
    request(nativeMetricsPath), request('/api/v1/health'),
  ])
  const value = nativeMetricSnapshot(metrics.body)
  if (!metrics.ok || !health.ok || !value) throw new Error('无法读取 Slim Health / 原生数值统计')
  return value
}

await readNativeCatalog(baseUrl, { minSessions: 1 })
const initial = await snapshot()
if (!initial.eligibleSessions || (!initial.missingSessions && !initial.staleSessions)) {
  console.log(JSON.stringify({ passed: false, verified: false, skipped: true,
    reason: '样本没有待重建统计；本次未覆盖重建与前台并发，请使用隔离的新索引样本', initial }, null, 2))
  process.exitCode = 1
} else {
  const startedAt = performance.now()
  const samples = []
  let failures = 0, rounds = 0, progressed = false, latest = initial
  const completed = value => value.readySessions + value.partialSessions
  // 对较长会话，单次有界重建可能尚未到 EOF；同时观察覆盖计数和实际前台延迟。
  while (performance.now() - startedAt < Math.min(durationMs, activationTimeoutMs)) {
    rounds++
    for (const result of await Promise.all(foreground.map(path => request(path)))) {
      samples.push(result.elapsedMs)
      if (!result.ok) failures++
    }
    latest = await snapshot()
    progressed ||= completed(latest) > completed(initial)
    if (latest.eligibleSessions !== initial.eligibleSessions || completed(latest) < completed(initial)) {
      throw new Error('验收期间样本集合改变或统计进度回退')
    }
    await delay(intervalMs)
  }
  const sorted = samples.sort((a,b) => a-b)
  const p95 = sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] ?? Infinity
  const passed = failures === 0 && progressed && p95 <= foregroundP95BudgetMs
  console.log(JSON.stringify({ passed, verified: passed, skipped: false,
    rounds, requests: samples.length, failures, foregroundP95Ms: p95,
    foregroundP95BudgetMs, initial, final: latest, progressed,
    complete: latest.coverage === 'complete',
    note: 'partial 快照仅证明重建取得进展，不表示 Hook/事件覆盖已完整认证',
  }, null, 2))
  if (!passed) process.exitCode = 1
}
