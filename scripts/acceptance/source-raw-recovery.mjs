const DEFAULT_BASE_URL = 'http://127.0.0.1:56789'
const DEFAULT_BATCH_SIZE = 100
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_PAGES = 100_000

function arg(name, fallback) {
  const prefix = `--${name}=`
  const value = process.argv.find(item => item.startsWith(prefix))?.slice(prefix.length)
  return value === undefined ? fallback : value
}

function positiveInt(name, fallback, max = Number.MAX_SAFE_INTEGER) {
  const value = Number.parseInt(arg(name, String(fallback)), 10)
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`)
  }
  return value
}

const options = {
  baseUrl: arg(
    'base-url',
    process.env.AGENT_LENS_ACCEPT_BASE_URL ?? DEFAULT_BASE_URL,
  ).replace(/\/$/, ''),
  batchSize: positiveInt('batch-size', DEFAULT_BATCH_SIZE, 500),
  timeoutMs: positiveInt('timeout-ms', DEFAULT_TIMEOUT_MS),
  maxPages: positiveInt('max-pages', DEFAULT_MAX_PAGES),
}

async function requestPage(after) {
  const params = new URLSearchParams({ limit: String(options.batchSize) })
  if (after) params.set('after', after)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  timer.unref?.()
  try {
    const response = await fetch(
      `${options.baseUrl}/api/v1/storage/source-raw-recovery-audit?${params}`,
      {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      },
    )
    let body = null
    try { body = await response.json() } catch { /* diagnostics below */ }
    if (!response.ok) {
      throw new Error(
        `Raw recovery audit HTTP ${response.status}: ${JSON.stringify(body)}`,
      )
    }
    return body
  } finally {
    clearTimeout(timer)
  }
}

function add(map, key, count = 1) {
  map.set(key, (map.get(key) ?? 0) + count)
}

const totals = {
  scanned: 0,
  eligible: 0,
  states: new Map(),
  sources: new Map(),
  reasons: new Map(),
}
const samples = []
let after
let pages = 0

console.log('AgentLens Source Raw recovery dry-run acceptance')
console.log(JSON.stringify({ options }, null, 2))

while (pages < options.maxPages) {
  const page = await requestPage(after)
  pages += 1
  const items = Array.isArray(page?.items) ? page.items : []

  for (const item of items) {
    totals.scanned += 1
    if (item?.decision?.autoReclaimEligible === true) totals.eligible += 1
    add(totals.states, String(item?.recovery?.state ?? 'unknown'))
    add(totals.sources, String(item?.sourceId ?? 'unknown'))
    const reasons = Array.isArray(item?.decision?.reasons)
      ? item.decision.reasons
      : []
    for (const reason of reasons) add(totals.reasons, String(reason))
    if (samples.length < 20 && (
      item?.recovery?.state === 'drifted'
      || item?.recovery?.state === 'unavailable'
      || reasons.length
    )) {
      samples.push({
        recordId: item?.recordId ?? null,
        sourceId: item?.sourceId ?? null,
        state: item?.recovery?.state ?? null,
        reasons,
      })
    }
  }

  const cursor = typeof page?.cursor === 'string' && page.cursor
    ? page.cursor
    : undefined
  console.log(
    `page=${pages} scanned=${items.length} total=${totals.scanned} eligible=${totals.eligible}`,
  )

  if (!page?.hasMore) {
    const report = {
      generatedAt: new Date().toISOString(),
      baseUrl: options.baseUrl,
      pages,
      scanned: totals.scanned,
      eligible: totals.eligible,
      eligibleRatio: totals.scanned ? totals.eligible / totals.scanned : 0,
      states: Object.fromEntries([...totals.states.entries()].sort()),
      sources: Object.fromEntries([...totals.sources.entries()].sort()),
      blockingReasons: Object.fromEntries(
        [...totals.reasons.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      ),
      samples,
      destructiveActionsPerformed: false,
    }
    console.log(JSON.stringify(report, null, 2))
    console.log('Source Raw recovery dry-run completed; no SourceRecord was deleted.')
    process.exit(0)
  }

  if (!cursor || cursor === after) {
    throw new Error('Raw recovery audit pagination did not advance')
  }
  after = cursor
}

throw new Error(`Raw recovery audit exceeded max-pages=${options.maxPages}`)
