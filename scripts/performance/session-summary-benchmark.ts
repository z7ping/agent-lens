import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  sessionSummaryProjectionSelectSql,
  SqliteStorageService,
} from '../../packages/storage-sqlite/src/index'

interface Options {
  sessions: number
  observationsPerSession: number
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
  sessions: readPositiveInt('sessions', 10_000),
  observationsPerSession: readPositiveInt('observations-per-session', 100),
  evidencePerObservation: readPositiveInt('evidence-per-observation', 2),
  samples: readPositiveInt('samples', 20),
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

const expectedObservations = options.sessions * options.observationsPerSession
const expectedEvidence = expectedObservations * options.evidencePerObservation
const root = mkdtempSync(join(tmpdir(), 'agent-lens-perf-'))
const databasePath = join(root, 'session-summary.db')
const storage = new SqliteStorageService({ path: databasePath })

console.log('AgentLens session summary benchmark')
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)
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
    insertWorkspace.run('workspace-perf', 'host-perf', 'project-perf', '/tmp/agent-lens-performance', null, null)

    const sourceIds = ['codex', 'claude-code', 'pi', 'hermes', 'opencode', 'deepseek-harness']
    for (let sessionIndex = 0; sessionIndex < options.sessions; sessionIndex += 1) {
      const logicalSessionId = `session-${sessionIndex.toString().padStart(6, '0')}`
      const sourceSessionId = `source-session-${sessionIndex.toString().padStart(6, '0')}`
      const sourceId = sourceIds[sessionIndex % sourceIds.length] ?? 'codex'
      const sessionBase = sessionIndex * options.observationsPerSession
      const startedAt = isoAt(sessionBase)
      const endedAt = isoAt(sessionBase + options.observationsPerSession - 1)
      insertSession.run(logicalSessionId, 'installation-perf', 'project-perf', 'workspace-perf', `Session ${sessionIndex}`, startedAt, endedAt)
      insertSourceSession.run(sourceSessionId, sourceId, 'installation-perf', `native-${sessionIndex}`, logicalSessionId, null)

      for (let observationIndex = 0; observationIndex < options.observationsPerSession; observationIndex += 1) {
        const sequence = observationIndex + 1
        const observationId = `obs-${sessionIndex}-${observationIndex}`
        const occurredAt = isoAt(sessionBase + observationIndex)
        let kind = 'message.assistant'
        let payload: Record<string, unknown> = { text: `assistant-${sessionIndex}-${observationIndex}` }
        if (observationIndex === 0) {
          kind = 'message.user'
          payload = { text: `user request for session ${sessionIndex}` }
        } else if (observationIndex % 5 === 1) {
          kind = 'tool.call'
          payload = { tool: 'Read', path: `/fixture/${sessionIndex}/${observationIndex}` }
        } else if (observationIndex % 5 === 2) {
          kind = 'tool.result'
          payload = { success: observationIndex % 20 !== 2, output: `result-${observationIndex}` }
        }

        insertObservation.run(
          observationId, 'host-perf', 'installation-perf', 'project-perf', 'workspace-perf',
          logicalSessionId, sourceSessionId, kind, sequence, sequence, occurredAt, occurredAt,
          JSON.stringify(payload),
        )

        for (let evidenceIndex = 0; evidenceIndex < options.evidencePerObservation; evidenceIndex += 1) {
          const evidenceId = `evidence-${sessionIndex}-${observationIndex}-${evidenceIndex}`
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
  if (counts.sessions !== options.sessions || counts.observations !== expectedObservations || counts.evidence !== expectedEvidence) {
    throw new Error(`fixture count mismatch: ${JSON.stringify(counts)}`)
  }

  const rebuildStart = performance.now()
  await storage.sessionSummaryProjection.rebuild()
  const projectionRebuildMs = performance.now() - rebuildStart
  const projectedSessions = Number((db.prepare('SELECT COUNT(*) AS count FROM session_summary_projection').get() as { count: number }).count)
  if (projectedSessions !== options.sessions) throw new Error(`projection count mismatch: ${projectedSessions}`)

  await storage.sessionSummaries.query({ limit: options.limit })
  const durations: number[] = []
  for (let sample = 0; sample < options.samples; sample += 1) {
    const started = performance.now()
    const result = await storage.sessionSummaries.query({ limit: options.limit })
    if (result.items.length !== Math.min(options.limit, options.sessions)) {
      throw new Error(`unexpected result size: ${result.items.length}`)
    }
    durations.push(performance.now() - started)
  }

  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sessionSummaryProjectionSelectSql('')}`)
    .all(options.limit + 1) as Array<{ detail: string }>

  const databaseBytes = fileSize(databasePath)
  const walBytes = fileSize(`${databasePath}-wal`)
  console.log(JSON.stringify({
    fixture: {
      ...counts,
      buildMs: Number(fixtureMs.toFixed(2)),
      databaseBytes,
      databaseMiB: mb(databaseBytes),
      walBytes,
      walMiB: mb(walBytes),
    },
    projection: {
      rows: projectedSessions,
      rebuildMs: Number(projectionRebuildMs.toFixed(2)),
    },
    sessionSummary: {
      limit: options.limit,
      samples: options.samples,
      minMs: Number(Math.min(...durations).toFixed(2)),
      p50Ms: Number(percentile(durations, 0.50).toFixed(2)),
      p95Ms: Number(percentile(durations, 0.95).toFixed(2)),
      maxMs: Number(Math.max(...durations).toFixed(2)),
    },
    queryPlan: plan.map(row => row.detail),
  }, null, 2))
} finally {
  storage.close()
  rmSync(root, { recursive: true, force: true })
}
