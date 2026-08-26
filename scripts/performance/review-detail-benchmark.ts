import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { ReviewProjection } from '../../packages/projection-review/src/index'
import { SqliteStorageService } from '../../packages/storage-sqlite/src/index'

interface Options {
  interactions: number
  observationsPerInteraction: number
  evidencePerObservation: number
  samples: number
  limit: number
}

function readPositiveInt(name: string, fallback: number): number {
  const prefix = `--${name}=`
  const raw = process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length)
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

const options: Options = {
  interactions: readPositiveInt('interactions', 2_000),
  observationsPerInteraction: readPositiveInt('observations-per-interaction', 10),
  evidencePerObservation: readPositiveInt('evidence-per-observation', 1),
  samples: readPositiveInt('samples', 10),
  limit: readPositiveInt('limit', 20),
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

function isoAt(offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 7, 1) + offsetSeconds * 1000).toISOString()
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

const expectedObservations = options.interactions * options.observationsPerInteraction
const expectedEvidence = expectedObservations * options.evidencePerObservation
const root = mkdtempSync(join(tmpdir(), 'agent-lens-review-perf-'))
const databasePath = join(root, 'review-detail.db')
const storage = new SqliteStorageService({ path: databasePath })
const review = new ReviewProjection(storage)
const logicalSessionId = 'session-long-review'

console.log('AgentLens long session review benchmark')
console.log(JSON.stringify({ ...options, expectedObservations, expectedEvidence }, null, 2))
console.log(`database: ${databasePath}`)

try {
  await storage.migrate()
  const { db } = storage
  db.pragma('synchronous = OFF')

  const fixtureStart = performance.now()
  const insertHost = db.prepare('INSERT INTO hosts(id, name, platform, arch, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
  const insertProduct = db.prepare('INSERT INTO agent_products(id, name, vendor, homepage) VALUES (?, ?, ?, ?)')
  const insertInstallation = db.prepare(`INSERT INTO agent_installations(id, host_id, product_id, version, executable, config_root, data_root, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const insertProject = db.prepare('INSERT INTO projects(id, name, repository_identity, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
  const insertWorkspace = db.prepare('INSERT INTO workspaces(id, host_id, project_id, path, repository_id, worktree_id) VALUES (?, ?, ?, ?, ?, ?)')
  const insertSession = db.prepare('INSERT INTO logical_sessions(id, installation_id, project_id, workspace_id, title, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const insertSourceSession = db.prepare('INSERT INTO source_sessions(id, source_id, installation_id, native_session_id, logical_session_id, native_parent_session_id) VALUES (?, ?, ?, ?, ?, ?)')
  const insertObservation = db.prepare(`
    INSERT INTO observations(
      id, host_id, installation_id, project_id, workspace_id, logical_session_id, source_session_id,
      interaction_id, actor_id, kind, source_sequence, canonical_sequence, occurred_at, captured_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
  `)
  const insertEvidence = db.prepare(`
    INSERT INTO evidence(id, capture_method, derivation, confidence, source_record_id, source_locator_json, parser_version, event_time, captured_at, missing_reason)
    VALUES (?, 'native-log', 'observed', 'exact', NULL, NULL, 'perf', ?, ?, NULL)
  `)
  const linkEvidence = db.prepare('INSERT INTO observation_evidence(observation_id, evidence_id) VALUES (?, ?)')

  db.transaction(() => {
    const createdAt = isoAt(0)
    insertHost.run('host-perf', 'perf-host', process.platform, process.arch, createdAt, createdAt)
    insertProduct.run('product-perf', 'Performance Fixture', 'AgentLens', null)
    insertInstallation.run('installation-perf', 'host-perf', 'product-perf', '1.0.0-alpha.0', null, null, null, createdAt, createdAt)
    insertProject.run('project-perf', 'Performance Fixture', 'perf/repository', createdAt, createdAt)
    insertWorkspace.run('workspace-perf', 'host-perf', 'project-perf', '/tmp/agent-lens-review-performance', null, null)
    insertSession.run(logicalSessionId, 'installation-perf', 'project-perf', 'workspace-perf', 'Long review session', createdAt, isoAt(options.interactions * 200 + 100))
    insertSourceSession.run('source-session-long', 'codex', 'installation-perf', 'native-long', logicalSessionId, null)

    let sequence = 0
    for (let interactionIndex = 0; interactionIndex < options.interactions; interactionIndex += 1) {
      const interactionId = `interaction-${interactionIndex}`
      const base = interactionIndex * 200
      const slow = interactionIndex % 10 === 0
      for (let observationIndex = 0; observationIndex < options.observationsPerInteraction; observationIndex += 1) {
        sequence += 1
        const observationId = `obs-${sequence}`
        const finalOffset = slow ? 100 : options.observationsPerInteraction - 1
        const offset = observationIndex === options.observationsPerInteraction - 1
          ? finalOffset
          : observationIndex
        const occurredAt = isoAt(base + offset)
        let kind = 'message.assistant'
        let payload: Record<string, unknown> = { text: `assistant-${interactionIndex}-${observationIndex}` }
        if (observationIndex === 0) {
          kind = 'message.user'
          payload = { text: `user request ${interactionIndex}` }
        } else if (observationIndex === 2) {
          kind = 'tool.call'
          payload = { callId: `call-${interactionIndex}`, toolName: 'Read', input: { path: `/fixture/${interactionIndex}` } }
        } else if (observationIndex === options.observationsPerInteraction - 1) {
          kind = 'tool.result'
          payload = {
            callId: `call-${interactionIndex}`,
            success: interactionIndex % 25 !== 0,
            output: `result-${interactionIndex}`,
          }
        }

        insertObservation.run(
          observationId, 'host-perf', 'installation-perf', 'project-perf', 'workspace-perf',
          logicalSessionId, 'source-session-long', interactionId, kind, sequence, sequence,
          occurredAt, occurredAt, JSON.stringify(payload),
        )

        for (let evidenceIndex = 0; evidenceIndex < options.evidencePerObservation; evidenceIndex += 1) {
          const evidenceId = `evidence-${sequence}-${evidenceIndex}`
          insertEvidence.run(evidenceId, occurredAt, occurredAt)
          linkEvidence.run(observationId, evidenceId)
        }
      }
    }
  })()

  db.pragma('synchronous = NORMAL')
  db.pragma('wal_checkpoint(TRUNCATE)')
  const fixtureMs = performance.now() - fixtureStart

  const counts = {
    sessions: Number((db.prepare('SELECT COUNT(*) AS count FROM logical_sessions').get() as { count: number }).count),
    observations: Number((db.prepare('SELECT COUNT(*) AS count FROM observations').get() as { count: number }).count),
    evidence: Number((db.prepare('SELECT COUNT(*) AS count FROM evidence').get() as { count: number }).count),
  }
  if (counts.observations !== expectedObservations || counts.evidence !== expectedEvidence) {
    throw new Error(`fixture count mismatch: ${JSON.stringify(counts)}`)
  }

  const results = []
  results.push(await measure('first-page-forward', options.samples, async () => {
    const detail = await review.get(logicalSessionId, { limit: options.limit, direction: 'forward' })
    if (!detail || detail.interactions.length !== Math.min(options.limit, options.interactions)) throw new Error('unexpected forward page')
  }))
  results.push(await measure('latest', options.samples, async () => {
    const detail = await review.get(logicalSessionId, { filter: 'latest' })
    if (!detail || detail.interactions.length !== 1) throw new Error('unexpected latest page')
  }))
  results.push(await measure('errors', options.samples, async () => {
    const detail = await review.get(logicalSessionId, { filter: 'errors', limit: options.limit })
    if (!detail) throw new Error('missing errors page')
  }))
  results.push(await measure('latency', options.samples, async () => {
    const detail = await review.get(logicalSessionId, { filter: 'latency', limit: options.limit })
    if (!detail) throw new Error('missing latency page')
  }))

  const plan = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT * FROM observations
    WHERE logical_session_id = ?
    ORDER BY
      COALESCE(occurred_at, captured_at),
      COALESCE(canonical_sequence, source_sequence, 9007199254740991),
      id
    LIMIT ?
  `).all(logicalSessionId, 250) as Array<{ detail: string }>

  const databaseBytes = fileSize(databasePath)
  const walBytes = fileSize(`${databasePath}-wal`)
  console.log(JSON.stringify({
    fixture: {
      ...counts,
      interactions: options.interactions,
      buildMs: Number(fixtureMs.toFixed(2)),
      databaseBytes,
      databaseMiB: mb(databaseBytes),
      walBytes,
      walMiB: mb(walBytes),
    },
    reviewDetail: results,
    queryPlan: plan.map(row => row.detail),
  }, null, 2))
} finally {
  storage.close()
  rmSync(root, { recursive: true, force: true })
}
