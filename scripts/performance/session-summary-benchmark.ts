import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { SqliteStorageService } from '../../packages/storage-sqlite/src/storage'

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
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
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
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))
  return sorted[index] ?? 0
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1)
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function isoAt(offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 7, 1) + offsetSeconds * 1000).toISOString()
}

function queryPlanSql(): string {
  // Keep this shape aligned with SqliteSessionSummaryReader. The benchmark itself
  // executes the production reader; this copy exists only so SQLite can expose
  // EXPLAIN QUERY PLAN without adding a diagnostics API to the production contract.
  return `
    EXPLAIN QUERY PLAN
    WITH session_aggregates AS (
      SELECT
        logical_session_id,
        MIN(COALESCE(occurred_at, captured_at)) AS started_at,
        MAX(COALESCE(occurred_at, captured_at)) AS ended_at,
        COUNT(*) AS observation_count,
        SUM(CASE WHEN kind = 'message.user' THEN 1 ELSE 0 END) AS user_message_count,
        SUM(CASE WHEN kind = 'tool.call' THEN 1 ELSE 0 END) AS tool_count,
        SUM(CASE
          WHEN kind = 'tool.result' AND json_extract(payload_json, '$.success') = 0 THEN 1
          ELSE 0
        END) AS error_count
      FROM observations
      GROUP BY logical_session_id
      ORDER BY ended_at DESC, logical_session_id ASC
      LIMIT ?
    )
    SELECT
      aggregate.*,
      logical.installation_id,
      installation.product_id,
      logical.project_id,
      project.name AS project_name,
      logical.workspace_id,
      workspace.path AS workspace_path,
      logical.title,
      (
        SELECT payload_json
        FROM observations AS first_user
        WHERE first_user.logical_session_id = aggregate.logical_session_id
          AND first_user.kind = 'message.user'
        ORDER BY
          COALESCE(first_user.occurred_at, first_user.captured_at) ASC,
          COALESCE(first_user.canonical_sequence, first_user.source_sequence, 9007199254740991) ASC,
          first_user.id ASC
        LIMIT 1
      ) AS first_user_payload,
      (
        SELECT kind
        FROM observations AS first_content
        WHERE first_content.logical_session_id = aggregate.logical_session_id
          AND first_content.kind <> 'session.lifecycle'
        ORDER BY
          COALESCE(first_content.occurred_at, first_content.captured_at) ASC,
          COALESCE(first_content.canonical_sequence, first_content.source_sequence, 9007199254740991) ASC,
          first_content.id ASC
        LIMIT 1
      ) AS leading_kind,
      (
        SELECT json_group_array(source_id)
        FROM (
          SELECT DISTINCT source_session.source_id
          FROM observations AS source_observation
          JOIN source_sessions AS source_session
            ON source_session.id = source_observation.source_session_id
          WHERE source_observation.logical_session_id = aggregate.logical_session_id
          ORDER BY source_session.source_id
        )
      ) AS source_ids_json
    FROM session_aggregates AS aggregate
    JOIN logical_sessions AS logical ON logical.id = aggregate.logical_session_id
    JOIN agent_installations AS installation ON installation.id = logical.installation_id
    LEFT JOIN projects AS project ON project.id = logical.project_id
    LEFT JOIN workspaces AS workspace ON workspace.id = logical.workspace_id
    ORDER BY aggregate.ended_at DESC, aggregate.logical_session_id ASC
  `
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
  const insertInstallation = db.prepare(`
    INSERT INTO agent_installations(id, host_id, product_id, version, executable, config_root, data_root, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertProject = db.prepare('INSERT INTO projects(id, name, repository_identity, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
  const insertWorkspace = db.prepare('INSERT INTO workspaces(id, host_id, project_id, path, repository_id, worktree_id) VALUES (?, ?, ?, ?, ?, ?)')
  const insertSession = db.prepare(`
    INSERT INTO logical_sessions(id, installation_id, project_id, workspace_id, title, started_at, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const insertSourceSession = db.prepare(`
    INSERT INTO source_sessions(id, source_id, installation_id, native_session_id, logical_session_id, native_parent_session_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const insertObservation = db.prepare(`
    INSERT INTO observations(
      id, host_id, installation_id, project_id, workspace_id, logical_session_id, source_session_id,
      interaction_id, actor_id, kind, source_sequence, canonical_sequence, occurred_at, captured_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)
  `)
  const insertEvidence = db.prepare(`
    INSERT INTO evidence(
      id, capture_method, derivation, confidence, source_record_id,
      source_locator_json, parser_version, event_time, captured_at, missing_reason
    ) VALUES (?, 'native-log', 'observed', 'exact', NULL, NULL, 'perf', ?, ?, NULL)
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
          observationId,
          'host-perf',
          'installation-perf',
          'project-perf',
          'workspace-perf',
          logicalSessionId,
          sourceSessionId,
          kind,
          sequence,
          sequence,
          occurredAt,
          occurredAt,
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

  await storage.sessionSummaries.query({ limit: options.limit })

  const durations: number[] = []
  for (let sample = 0; sample < options.samples; sample += 1) {
    const started = performance.now()
    const result = await storage.sessionSummaries.query({ limit: options.limit })
    const duration = performance.now() - started
    if (result.items.length !== Math.min(options.limit, options.sessions)) {
      throw new Error(`unexpected result size: ${result.items.length}`)
    }
    durations.push(duration)
  }

  const plan = db.prepare(queryPlanSql()).all(options.limit + 1) as Array<{ id: number; parent: number; notused: number; detail: string }>
  const report = {
    fixture: {
      ...counts,
      buildMs: Number(fixtureMs.toFixed(2)),
      databaseBytes: fileSize(databasePath),
      databaseMiB: mb(fileSize(databasePath)),
      walBytes: fileSize(`${databasePath}-wal`),
      walMiB: mb(fileSize(`${databasePath}-wal`)),
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
  }

  console.log(JSON.stringify(report, null, 2))
} finally {
  storage.close()
  rmSync(root, { recursive: true, force: true })
}
