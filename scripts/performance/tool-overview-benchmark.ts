import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { AgentOverviewProjection } from '../../packages/projection-overview/src/index'
import { ToolAssetUsageProjection } from '../../packages/projection-usage/src/index'
import { SqliteStorageService } from '../../packages/storage-sqlite/src/index'

interface Options {
  installations: number
  sessionsPerInstallation: number
  callsPerSession: number
  evidencePerObservation: number
  samples: number
  limit: number
  globalP95BudgetMs: number | null
  overviewP95BudgetMs: number | null
}

function readPositiveInt(name: string, fallback: number): number {
  const prefix = `--${name}=`
  const raw = process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length)
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function readOptionalPositiveInt(name: string): number | null {
  const prefix = `--${name}=`
  const raw = process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length)
  if (!raw) return null
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

const options: Options = {
  installations: readPositiveInt('installations', 6),
  sessionsPerInstallation: readPositiveInt('sessions-per-installation', 100),
  callsPerSession: readPositiveInt('calls-per-session', 100),
  evidencePerObservation: readPositiveInt('evidence-per-observation', 1),
  samples: readPositiveInt('samples', 10),
  limit: readPositiveInt('limit', 100),
  globalP95BudgetMs: readOptionalPositiveInt('global-p95-budget-ms'),
  overviewP95BudgetMs: readOptionalPositiveInt('overview-p95-budget-ms'),
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))
  return sorted[index] ?? 0
}

function fileSize(path: string): number {
  try { return statSync(path).size } catch { return 0 }
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1)
}

function isoAt(offsetMs: number): string {
  return new Date(Date.UTC(2026, 7, 1) + offsetMs).toISOString()
}

async function measure(
  name: string,
  samples: number,
  run: () => Promise<unknown>,
): Promise<{ name: string; minMs: number; p50Ms: number; p95Ms: number; maxMs: number }> {
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

const toolObservationsPerCall = 2
const expectedSessions = options.installations * options.sessionsPerInstallation
const expectedCalls = expectedSessions * options.callsPerSession
const expectedObservations = expectedCalls * toolObservationsPerCall
const expectedEvidence = expectedObservations * options.evidencePerObservation
const root = mkdtempSync(join(tmpdir(), 'agent-lens-tool-overview-perf-'))
const databasePath = join(root, 'tool-overview.db')
const storage = new SqliteStorageService({ path: databasePath })
const usage = new ToolAssetUsageProjection(storage)
const productId = 'product-perf'
const sourceId = 'codex'

const sources = {
  list: () => [{
    manifest: {
      sourceId,
      productId,
      displayName: 'Performance Agent',
    },
  }],
} as any
const overview = new AgentOverviewProjection(storage, sources)

console.log('AgentLens tool analysis / agent overview benchmark')
console.log(JSON.stringify({
  ...options,
  expectedSessions,
  expectedCalls,
  expectedObservations,
  expectedEvidence,
}, null, 2))
console.log(`database: ${databasePath}`)

try {
  await storage.migrate()
  const { db } = storage
  db.pragma('synchronous = OFF')

  const fixtureStart = performance.now()
  const insertHost = db.prepare('INSERT INTO hosts(id, name, platform, arch, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
  const insertProduct = db.prepare('INSERT INTO agent_products(id, name, vendor, homepage) VALUES (?, ?, ?, ?)')
  const insertInstallation = db.prepare(`INSERT INTO agent_installations(id, host_id, product_id, version, executable, config_root, data_root, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const insertSession = db.prepare('INSERT INTO logical_sessions(id, installation_id, project_id, workspace_id, title, started_at, ended_at) VALUES (?, ?, NULL, NULL, ?, ?, ?)')
  const insertSourceSession = db.prepare('INSERT INTO source_sessions(id, source_id, installation_id, native_session_id, logical_session_id, native_parent_session_id) VALUES (?, ?, ?, ?, ?, NULL)')
  const insertObservation = db.prepare(`
    INSERT INTO observations(
      id, host_id, installation_id, project_id, workspace_id, logical_session_id, source_session_id,
      interaction_id, actor_id, kind, source_sequence, canonical_sequence, occurred_at, captured_at, payload_json
    ) VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)
  `)
  const insertEvidence = db.prepare(`
    INSERT INTO evidence(id, capture_method, derivation, confidence, source_record_id, source_locator_json, parser_version, event_time, captured_at, missing_reason)
    VALUES (?, 'native-log', 'observed', 'exact', NULL, NULL, 'perf', ?, ?, NULL)
  `)
  const linkEvidence = db.prepare('INSERT INTO observation_evidence(observation_id, evidence_id) VALUES (?, ?)')

  db.transaction(() => {
    const createdAt = isoAt(0)
    insertHost.run('host-perf', 'perf-host', process.platform, process.arch, createdAt, createdAt)
    insertProduct.run(productId, 'Performance Fixture', 'AgentLens', null)

    let globalSequence = 0
    for (let installationIndex = 0; installationIndex < options.installations; installationIndex += 1) {
      const installationId = `installation-${installationIndex}`
      insertInstallation.run(
        installationId,
        'host-perf',
        productId,
        '1.0.0-alpha.0',
        null,
        `/tmp/agent-lens-${installationIndex}`,
        null,
        createdAt,
        createdAt,
      )

      for (let sessionIndex = 0; sessionIndex < options.sessionsPerInstallation; sessionIndex += 1) {
        const logicalSessionId = `session-${installationIndex}-${sessionIndex}`
        const sourceSessionId = `source-session-${installationIndex}-${sessionIndex}`
        const sessionBase = (installationIndex * options.sessionsPerInstallation + sessionIndex) * options.callsPerSession * 10
        insertSession.run(logicalSessionId, installationId, `Session ${installationIndex}/${sessionIndex}`, isoAt(sessionBase), isoAt(sessionBase + options.callsPerSession * 10))
        insertSourceSession.run(sourceSessionId, sourceId, installationId, `native-${installationIndex}-${sessionIndex}`, logicalSessionId)

        for (let callIndex = 0; callIndex < options.callsPerSession; callIndex += 1) {
          const callId = `call-${installationIndex}-${sessionIndex}-${callIndex}`
          const nativeToolName = callIndex % 5 === 0
            ? `mcp__server-${callIndex % 4}__tool-${callIndex % 7}`
            : callIndex % 7 === 0
              ? 'Skill'
              : ['Read', 'Write', 'Bash', 'Grep'][callIndex % 4]!
          const callAt = isoAt(sessionBase + callIndex * 10)
          const resultAt = isoAt(sessionBase + callIndex * 10 + 5)
          const callObservationId = `obs-${++globalSequence}`
          const resultObservationId = `obs-${++globalSequence}`
          const callPayload = nativeToolName === 'Skill'
            ? { callId, toolName: nativeToolName, input: { skill: `skill-${callIndex % 6}` } }
            : { callId, toolName: nativeToolName, input: { path: `/fixture/${callIndex}` } }
          const resultPayload = {
            callId,
            success: callIndex % 23 !== 0,
            durationMs: 5 + (callIndex % 50),
            output: `result-${callIndex}`,
          }

          insertObservation.run(callObservationId, 'host-perf', installationId, logicalSessionId, sourceSessionId, 'tool.call', globalSequence - 1, globalSequence - 1, callAt, callAt, JSON.stringify(callPayload))
          insertObservation.run(resultObservationId, 'host-perf', installationId, logicalSessionId, sourceSessionId, 'tool.result', globalSequence, globalSequence, resultAt, resultAt, JSON.stringify(resultPayload))

          for (const [observationId, at] of [[callObservationId, callAt], [resultObservationId, resultAt]] as const) {
            for (let evidenceIndex = 0; evidenceIndex < options.evidencePerObservation; evidenceIndex += 1) {
              const evidenceId = `evidence-${observationId}-${evidenceIndex}`
              insertEvidence.run(evidenceId, at, at)
              linkEvidence.run(observationId, evidenceId)
            }
          }
        }
      }
    }
  })()

  db.pragma('synchronous = NORMAL')
  db.pragma('wal_checkpoint(TRUNCATE)')
  const fixtureMs = performance.now() - fixtureStart

  const counts = {
    installations: Number((db.prepare('SELECT COUNT(*) AS count FROM agent_installations').get() as { count: number }).count),
    sessions: Number((db.prepare('SELECT COUNT(*) AS count FROM logical_sessions').get() as { count: number }).count),
    observations: Number((db.prepare('SELECT COUNT(*) AS count FROM observations').get() as { count: number }).count),
    evidence: Number((db.prepare('SELECT COUNT(*) AS count FROM evidence').get() as { count: number }).count),
  }
  if (
    counts.installations !== options.installations
    || counts.sessions !== expectedSessions
    || counts.observations !== expectedObservations
    || counts.evidence !== expectedEvidence
  ) {
    throw new Error(`fixture count mismatch: ${JSON.stringify(counts)}`)
  }

  const firstInstallationId = 'installation-0'
  const repositoryRowsPerKind = options.sessionsPerInstallation * options.callsPerSession
  const results = []

  results.push(await measure('raw-select-one-installation-call-page', options.samples, async () => {
    const rows = db.prepare(`
      SELECT id, installation_id, logical_session_id, source_session_id, kind, occurred_at, captured_at, payload_json
      FROM observations
      WHERE installation_id = ? AND kind = 'tool.call'
      ORDER BY
        COALESCE(occurred_at, captured_at) ASC,
        COALESCE(canonical_sequence, source_sequence, 9007199254740991) ASC,
        id ASC
      LIMIT 1000
    `).all(firstInstallationId)
    if (rows.length !== Math.min(1000, repositoryRowsPerKind)) throw new Error('unexpected raw select page')
  }))

  results.push(await measure('tool-analysis-one-installation', options.samples, async () => {
    const result = await usage.query({ installationId: firstInstallationId, limit: options.limit })
    if (!result.tools.length) throw new Error('missing tool analysis result')
  }))

  results.push(await measure('tool-analysis-global', options.samples, async () => {
    const result = await usage.query({ limit: options.limit })
    if (!result.tools.length) throw new Error('missing global tool analysis result')
  }))

  results.push(await measure('agent-overview-all-installations', options.samples, async () => {
    const result = await overview.query()
    if (result.items.length !== 1 || result.items[0]?.installations.length !== options.installations) {
      throw new Error('unexpected agent overview result')
    }
  }))

  const oneInstallationPlan = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT * FROM observations
    WHERE installation_id = ? AND kind = ?
    ORDER BY
      COALESCE(occurred_at, captured_at) ASC,
      COALESCE(canonical_sequence, source_sequence, 9007199254740991) ASC,
      id ASC
    LIMIT 1000
  `).all(firstInstallationId, 'tool.call') as Array<{ detail: string }>

  const globalPlan = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT * FROM observations
    WHERE kind = ?
    ORDER BY
      COALESCE(occurred_at, captured_at) ASC,
      COALESCE(canonical_sequence, source_sequence, 9007199254740991) ASC,
      id ASC
    LIMIT 1000
  `).all('tool.call') as Array<{ detail: string }>

  const evidencePlan = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT observation_id, evidence_id
    FROM observation_evidence
    WHERE observation_id IN (?, ?, ?)
    ORDER BY observation_id, evidence_id
  `).all('obs-1', 'obs-2', 'obs-3') as Array<{ detail: string }>

  const databaseBytes = fileSize(databasePath)
  const walBytes = fileSize(`${databasePath}-wal`)
  const globalTiming = results.find(item => item.name === 'tool-analysis-global')
  const overviewTiming = results.find(item => item.name === 'agent-overview-all-installations')
  const budgetViolations = [
    options.globalP95BudgetMs !== null && globalTiming && globalTiming.p95Ms > options.globalP95BudgetMs
      ? `tool-analysis-global p95 ${globalTiming.p95Ms}ms exceeds ${options.globalP95BudgetMs}ms`
      : null,
    options.overviewP95BudgetMs !== null && overviewTiming && overviewTiming.p95Ms > options.overviewP95BudgetMs
      ? `agent-overview-all-installations p95 ${overviewTiming.p95Ms}ms exceeds ${options.overviewP95BudgetMs}ms`
      : null,
  ].filter((item): item is string => item !== null)

  console.log(JSON.stringify({
    fixture: {
      ...counts,
      calls: expectedCalls,
      buildMs: Number(fixtureMs.toFixed(2)),
      databaseBytes,
      databaseMiB: mb(databaseBytes),
      walBytes,
      walMiB: mb(walBytes),
    },
    workload: {
      toolRowsPerInstallationPerKind: repositoryRowsPerKind,
      toolRowsGlobalPerKind: expectedCalls,
      overviewRepeatedUsageQueries: options.installations,
    },
    timings: results,
    budgets: {
      globalP95Ms: options.globalP95BudgetMs,
      overviewP95Ms: options.overviewP95BudgetMs,
      passed: budgetViolations.length === 0,
    },
    oneInstallationQueryPlan: oneInstallationPlan.map(row => row.detail),
    globalQueryPlan: globalPlan.map(row => row.detail),
    evidenceLookupQueryPlan: evidencePlan.map(row => row.detail),
  }, null, 2))
  if (budgetViolations.length) throw new Error(`performance budget failed: ${budgetViolations.join('; ')}`)
} finally {
  await storage.close()
  rmSync(root, { recursive: true, force: true })
}
