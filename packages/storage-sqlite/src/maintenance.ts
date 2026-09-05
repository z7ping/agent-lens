import { existsSync, statSync } from 'node:fs'
import type { SqliteExecutor } from './executor'
import { encodeSourceRecordPayloadJson, SOURCE_RECORD_COMPRESSION_THRESHOLD_BYTES } from './source-record-compression'

export interface SourceRecordCompressionResult {
  scanned: number
  compressed: number
  plain: number
  rawBytes: number
  storedBytes: number
  savedBytes: number
  cursor?: string
  hasMore: boolean
}

export interface SessionRetentionInput {
  before: string
  limit?: number
  dryRun?: boolean
}

export interface SessionRetentionResult {
  dryRun: boolean
  sessionIds: string[]
  observationsDeleted: number
  evidenceDeleted: number
  sourceRecordsDeleted: number
  sourceSessionsDeleted: number
  sessionsDeleted: number
}

export interface IndexAuditCandidate {
  table: string
  index: string
  coveredBy: string
  reason: 'duplicate' | 'prefix'
  columns: string[]
}

export interface DeferredIndexMaintenanceResult {
  created: string[]
  existing: string[]
}

const DEFERRED_INDEXES = [
  {
    name: 'idx_source_records_parser_replay',
    sql: `CREATE INDEX IF NOT EXISTS idx_source_records_parser_replay
          ON source_records(source_id, installation_id, parser_version, captured_at, id)`,
  },
  {
    name: 'idx_observations_captured_at',
    sql: `CREATE INDEX IF NOT EXISTS idx_observations_captured_at
          ON observations(captured_at)`,
  },
  {
    name: 'idx_evidence_captured_at',
    sql: `CREATE INDEX IF NOT EXISTS idx_evidence_captured_at
          ON evidence(captured_at)`,
  },
] as const

export class SqliteStorageMaintenance {
  constructor(private readonly executor: SqliteExecutor) {}

  async ensureDeferredIndexes(): Promise<DeferredIndexMaintenanceResult> {
    return this.executor.run(() => {
      const created: string[] = []
      const existing: string[] = []
      const lookup = this.executor.db.prepare(`
        SELECT 1 AS found
        FROM sqlite_master
        WHERE type = 'index' AND name = ?
      `)
      for (const index of DEFERRED_INDEXES) {
        if (lookup.get(index.name)) {
          existing.push(index.name)
          continue
        }
        this.executor.db.exec(index.sql)
        created.push(index.name)
      }
      return { created, existing }
    })
  }

  async compressSourceRecords(limit = 250, afterId?: string): Promise<SourceRecordCompressionResult> {
    const batchLimit = Math.max(1, Math.min(limit, 2000))
    const rows = await this.executor.run(() => this.executor.db.prepare(`
      SELECT id, payload_json
      FROM source_records
      WHERE payload_encoding = 'json'
        AND (? IS NULL OR id > ?)
      ORDER BY id ASC
      LIMIT ?
    `).all(afterId ?? null, afterId ?? null, batchLimit) as Array<{ id: string; payload_json: string }>)

    const encoded = rows.map(row => ({ id: row.id, encoded: encodeSourceRecordPayloadJson(row.payload_json) }))
    await this.executor.transaction(async () => {
      const update = this.executor.db.prepare(`
        UPDATE source_records
        SET payload_json = ?, payload_blob = ?, payload_encoding = ?
        WHERE id = ? AND payload_encoding = 'json'
      `)
      for (const item of encoded) {
        update.run(
          item.encoded.payloadJson,
          item.encoded.payloadBlob,
          item.encoded.payloadEncoding,
          item.id,
        )
      }
    })

    const rawBytes = encoded.reduce((sum, item) => sum + item.encoded.rawBytes, 0)
    const storedBytes = encoded.reduce((sum, item) => sum + item.encoded.storedBytes, 0)
    const cursor = rows.at(-1)?.id
    return {
      scanned: encoded.length,
      compressed: encoded.filter(item => item.encoded.payloadEncoding === 'gzip-json').length,
      plain: encoded.filter(item => item.encoded.payloadEncoding === 'plain-json').length,
      rawBytes,
      storedBytes,
      savedBytes: Math.max(0, rawBytes - storedBytes),
      ...(cursor ? { cursor } : {}),
      hasMore: encoded.length === batchLimit,
    }
  }

  async purgeSessions(input: SessionRetentionInput): Promise<SessionRetentionResult> {
    if (!Number.isFinite(Date.parse(input.before))) throw new Error('Retention cutoff must be a valid timestamp')
    const limit = Math.max(1, Math.min(input.limit ?? 50, 500))
    const sessionIds = await this.executor.run(() => (
      this.executor.db.prepare(`
        SELECT logical_session_id AS id
        FROM session_summary_projection
        WHERE ended_at < ?
        ORDER BY ended_at ASC, logical_session_id ASC
        LIMIT ?
      `).all(input.before, limit) as Array<{ id: string }>
    ).map(row => row.id))

    const empty: SessionRetentionResult = {
      dryRun: input.dryRun ?? true,
      sessionIds,
      observationsDeleted: 0,
      evidenceDeleted: 0,
      sourceRecordsDeleted: 0,
      sourceSessionsDeleted: 0,
      sessionsDeleted: 0,
    }
    if ((input.dryRun ?? true) || !sessionIds.length) return empty

    return this.executor.transaction(async () => {
      const db = this.executor.db
      db.exec(`
        CREATE TEMP TABLE IF NOT EXISTS agent_lens_purge_sessions(id TEXT PRIMARY KEY);
        CREATE TEMP TABLE IF NOT EXISTS agent_lens_purge_evidence(id TEXT PRIMARY KEY);
        CREATE TEMP TABLE IF NOT EXISTS agent_lens_purge_source_records(id TEXT PRIMARY KEY);
        DELETE FROM agent_lens_purge_sessions;
        DELETE FROM agent_lens_purge_evidence;
        DELETE FROM agent_lens_purge_source_records;
      `)
      const insertSession = db.prepare('INSERT OR IGNORE INTO agent_lens_purge_sessions(id) VALUES (?)')
      for (const id of sessionIds) insertSession.run(id)

      db.prepare(`
        INSERT OR IGNORE INTO agent_lens_purge_evidence(id)
        SELECT DISTINCT oe.evidence_id
        FROM observation_evidence oe
        JOIN observations o ON o.id = oe.observation_id
        JOIN agent_lens_purge_sessions p ON p.id = o.logical_session_id
      `).run()
      db.prepare(`
        INSERT OR IGNORE INTO agent_lens_purge_source_records(id)
        SELECT DISTINCT e.source_record_id
        FROM evidence e
        JOIN agent_lens_purge_evidence pe ON pe.id = e.id
        WHERE e.source_record_id IS NOT NULL
      `).run()
      db.prepare(`
        INSERT OR IGNORE INTO agent_lens_purge_source_records(id)
        SELECT sr.id
        FROM source_records sr
        JOIN source_sessions ss
          ON ss.source_id = sr.source_id
         AND ss.installation_id = sr.installation_id
         AND ss.native_session_id = sr.source_session_native_id
        JOIN agent_lens_purge_sessions p ON p.id = ss.logical_session_id
      `).run()

      db.prepare(`
        DELETE FROM session_relationships
        WHERE from_session_id IN (SELECT id FROM agent_lens_purge_sessions)
           OR to_session_id IN (SELECT id FROM agent_lens_purge_sessions)
      `).run()
      db.prepare(`
        DELETE FROM session_relationship_candidates
        WHERE source_record_id IN (SELECT id FROM agent_lens_purge_source_records)
           OR EXISTS (
             SELECT 1
             FROM source_sessions ss
             JOIN agent_lens_purge_sessions p ON p.id = ss.logical_session_id
             WHERE ss.source_id = session_relationship_candidates.source_id
               AND ss.installation_id = session_relationship_candidates.installation_id
               AND (
                 ss.native_session_id = session_relationship_candidates.from_native_session_id
                 OR ss.native_session_id = session_relationship_candidates.to_native_session_id
               )
           )
      `).run()

      const observationsDeleted = Number(db.prepare(`
        DELETE FROM observations
        WHERE logical_session_id IN (SELECT id FROM agent_lens_purge_sessions)
      `).run().changes)
      db.prepare(`
        DELETE FROM interactions
        WHERE logical_session_id IN (SELECT id FROM agent_lens_purge_sessions)
      `).run()
      db.prepare(`
        UPDATE agent_actors
        SET parent_actor_id = NULL
        WHERE parent_actor_id IN (
          SELECT id FROM agent_actors
          WHERE logical_session_id IN (SELECT id FROM agent_lens_purge_sessions)
        )
        AND logical_session_id NOT IN (SELECT id FROM agent_lens_purge_sessions)
      `).run()
      db.prepare(`
        DELETE FROM agent_actors
        WHERE logical_session_id IN (SELECT id FROM agent_lens_purge_sessions)
      `).run()

      const evidenceDeleted = Number(db.prepare(`
        DELETE FROM evidence
        WHERE id IN (SELECT id FROM agent_lens_purge_evidence)
          AND NOT EXISTS (
            SELECT 1 FROM observation_evidence oe WHERE oe.evidence_id = evidence.id
          )
      `).run().changes)
      const sourceRecordsDeleted = Number(db.prepare(`
        DELETE FROM source_records
        WHERE id IN (SELECT id FROM agent_lens_purge_source_records)
          AND NOT EXISTS (
            SELECT 1 FROM evidence e WHERE e.source_record_id = source_records.id
          )
      `).run().changes)
      const sourceSessionsDeleted = Number(db.prepare(`
        DELETE FROM source_sessions
        WHERE logical_session_id IN (SELECT id FROM agent_lens_purge_sessions)
      `).run().changes)
      const sessionsDeleted = Number(db.prepare(`
        DELETE FROM logical_sessions
        WHERE id IN (SELECT id FROM agent_lens_purge_sessions)
      `).run().changes)

      db.exec(`
        DELETE FROM agent_lens_purge_sessions;
        DELETE FROM agent_lens_purge_evidence;
        DELETE FROM agent_lens_purge_source_records;
      `)
      return {
        dryRun: false,
        sessionIds,
        observationsDeleted,
        evidenceDeleted,
        sourceRecordsDeleted,
        sourceSessionsDeleted,
        sessionsDeleted,
      }
    })
  }

  async vacuumInto(destinationPath: string): Promise<{ path: string; bytes: number }> {
    if (!destinationPath) throw new Error('VACUUM INTO destination is required')
    if (this.executor.db.memory) throw new Error('VACUUM INTO is not supported for in-memory storage')
    if (this.executor.db.readonly) throw new Error('VACUUM INTO requires writable storage')
    if (existsSync(destinationPath)) throw new Error(`VACUUM INTO destination already exists: ${destinationPath}`)
    await this.executor.run(() => {
      this.executor.db.pragma('wal_checkpoint(TRUNCATE)')
      this.executor.db.prepare('VACUUM INTO ?').run(destinationPath)
    })
    return { path: destinationPath, bytes: statSync(destinationPath).size }
  }

  async auditIndexes(): Promise<IndexAuditCandidate[]> {
    return this.executor.run(() => {
      const tables = this.executor.db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all() as Array<{ name: string }>
      const candidates: IndexAuditCandidate[] = []
      for (const table of tables) {
        const indexes = this.executor.db.prepare(`PRAGMA index_list(${JSON.stringify(table.name)})`).all() as Array<{
          name: string
          unique: number
          origin: string
          partial: number
        }>
        const described = indexes
          .filter(index => index.origin === 'c' && index.unique === 0 && index.partial === 0)
          .map(index => ({
            name: index.name,
            columns: (this.executor.db.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as Array<{
              name: string | null
            }>).map(column => column.name).filter((name): name is string => Boolean(name)),
          }))
          .filter(index => index.columns.length > 0)
        for (const left of described) {
          for (const right of described) {
            if (left.name === right.name || left.columns.length > right.columns.length) continue
            const prefix = left.columns.every((column, index) => right.columns[index] === column)
            if (!prefix) continue
            candidates.push({
              table: table.name,
              index: left.name,
              coveredBy: right.name,
              reason: left.columns.length === right.columns.length ? 'duplicate' : 'prefix',
              columns: left.columns,
            })
            break
          }
        }
      }
      return candidates.sort((a, b) => a.table.localeCompare(b.table) || a.index.localeCompare(b.index))
    })
  }
}

export const maintenanceInternals = {
  SOURCE_RECORD_COMPRESSION_THRESHOLD_BYTES,
  DEFERRED_INDEXES,
}
