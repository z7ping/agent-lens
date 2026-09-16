import type Database from 'better-sqlite3'
import {
  OBSERVATION_ROOT_REPLICATION_ENTITY_TYPES,
  type KnownReplicationEntityType,
} from '@agent-lens/core/replication'
import type { SqliteExecutor } from './executor'

export type ReplicationCaptureDependencyState = 'dependent' | 'retired'

export const REPLICATION_JOURNAL_GC_COVERED_ENTITY_TYPES =
  OBSERVATION_ROOT_REPLICATION_ENTITY_TYPES

export interface ReplicationCaptureWatermark {
  streamId: string
  generationId: string
  entityType: KnownReplicationEntityType
  capturedRevision: number
  dependencyState: ReplicationCaptureDependencyState
  updatedAt: string
}

export interface ReplicationJournalBlocker {
  streamId: string
  generationId: string
  entityType: KnownReplicationEntityType
  capturedRevision: number
  streamStatus: string
  source: 'capture-watermark' | 'snapshot-baseline'
}

export interface ReplicationJournalSafety {
  available: boolean
  highWaterRevision: number
  safeJournalRevision: number
  oldestRetainedRevision: number | null
  retainedChanges: number
  reclaimableChanges: number
  uncoveredChanges: number
  gcCoveredEntityTypes: readonly KnownReplicationEntityType[]
  dependentRoots: number
  blockingStreams: ReplicationJournalBlocker[]
}

type Row = Record<string, unknown>

function rowRecord(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Replication journal lifecycle row must be an object')
  }
  return value as Row
}
function requiredString(row: Row, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new TypeError(`Replication journal lifecycle field ${key} must be a string`)
  return value
}
function requiredNumber(row: Row, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Replication journal lifecycle field ${key} must be a finite number`)
  }
  return value
}
function nullableNumber(row: Row, key: string): number | null {
  const value = row[key]
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Replication journal lifecycle field ${key} must be a finite number or null`)
  }
  return value
}
function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
}
function persistentHighWater(db: Database.Database): number {
  if (tableExists(db, 'replication_journal_state')) {
    const state = db.prepare(`
      SELECT high_water_revision AS revision FROM replication_journal_state WHERE singleton = 1
    `).get()
    if (state) return requiredNumber(rowRecord(state), 'revision')
  }
  return requiredNumber(rowRecord(db.prepare(`
    SELECT COALESCE(MAX(revision), 0) AS revision FROM replication_canonical_changes
  `).get()), 'revision')
}
function mapCaptureWatermark(value: unknown): ReplicationCaptureWatermark {
  const row = rowRecord(value)
  const dependencyState = requiredString(row, 'dependencyState')
  if (dependencyState !== 'dependent' && dependencyState !== 'retired') {
    throw new TypeError(`Unsupported replication capture dependency state: ${dependencyState}`)
  }
  return {
    streamId: requiredString(row, 'streamId'),
    generationId: requiredString(row, 'generationId'),
    entityType: requiredString(row, 'entityType') as KnownReplicationEntityType,
    capturedRevision: requiredNumber(row, 'capturedRevision'),
    dependencyState,
    updatedAt: requiredString(row, 'updatedAt'),
  }
}

export function replicationJournalSafetyDetails(db: Database.Database): ReplicationJournalSafety {
  if (
    !tableExists(db, 'replication_canonical_changes')
    || !tableExists(db, 'replication_journal_state')
    || !tableExists(db, 'replication_capture_watermarks')
  ) {
    return {
      available: false,
      highWaterRevision: tableExists(db, 'replication_canonical_changes') ? persistentHighWater(db) : 0,
      safeJournalRevision: 0,
      oldestRetainedRevision: null,
      retainedChanges: 0,
      reclaimableChanges: 0,
      uncoveredChanges: 0,
      gcCoveredEntityTypes: [...REPLICATION_JOURNAL_GC_COVERED_ENTITY_TYPES],
      dependentRoots: 0,
      blockingStreams: [],
    }
  }

  const highWaterRevision = persistentHighWater(db)
  const explicit: ReplicationJournalBlocker[] = db.prepare(`
    SELECT c.stream_id AS streamId,
           c.generation_id AS generationId,
           c.entity_type AS entityType,
           c.captured_revision AS capturedRevision,
           s.status AS streamStatus
    FROM replication_capture_watermarks c
    JOIN replication_streams s ON s.stream_id = c.stream_id
    WHERE c.dependency_state = 'dependent'
  `).all().map(value => {
    const row = rowRecord(value)
    return {
      streamId: requiredString(row, 'streamId'),
      generationId: requiredString(row, 'generationId'),
      entityType: requiredString(row, 'entityType') as KnownReplicationEntityType,
      capturedRevision: requiredNumber(row, 'capturedRevision'),
      streamStatus: requiredString(row, 'streamStatus'),
      source: 'capture-watermark' as const,
    }
  })

  const implicit: ReplicationJournalBlocker[] = tableExists(db, 'replication_snapshot_bootstrap_progress')
    ? db.prepare(`
        SELECT p.stream_id AS streamId,
               p.generation_id AS generationId,
               p.entity_type AS entityType,
               p.baseline_revision AS capturedRevision,
               s.status AS streamStatus
        FROM replication_snapshot_bootstrap_progress p
        JOIN replication_streams s ON s.stream_id = p.stream_id
        LEFT JOIN replication_capture_watermarks c
          ON c.stream_id = p.stream_id
         AND c.generation_id = p.generation_id
         AND c.entity_type = p.entity_type
        WHERE c.stream_id IS NULL
      `).all().map(value => {
        const row = rowRecord(value)
        return {
          streamId: requiredString(row, 'streamId'),
          generationId: requiredString(row, 'generationId'),
          entityType: requiredString(row, 'entityType') as KnownReplicationEntityType,
          capturedRevision: requiredNumber(row, 'capturedRevision'),
          streamStatus: requiredString(row, 'streamStatus'),
          source: 'snapshot-baseline' as const,
        }
      })
    : []

  const dependencies = [...explicit, ...implicit]
  const safeJournalRevision = dependencies.length
    ? Math.min(...dependencies.map(item => item.capturedRevision))
    : highWaterRevision
  const retained = rowRecord(db.prepare(`
    SELECT COUNT(*) AS retainedChanges, MIN(revision) AS oldestRetainedRevision
    FROM replication_canonical_changes
  `).get())
  const retainedChanges = requiredNumber(retained, 'retainedChanges')
  const oldestRetainedRevision = nullableNumber(retained, 'oldestRetainedRevision')
  const coveredPlaceholders = REPLICATION_JOURNAL_GC_COVERED_ENTITY_TYPES.map(() => '?').join(', ')
  const reclaimableChanges = requiredNumber(rowRecord(db.prepare(`
    SELECT COUNT(*) AS reclaimableChanges
    FROM replication_canonical_changes
    WHERE entity_type IN (${coveredPlaceholders})
      AND revision <= ?
  `).get(...REPLICATION_JOURNAL_GC_COVERED_ENTITY_TYPES, safeJournalRevision)), 'reclaimableChanges')
  const uncoveredChanges = requiredNumber(rowRecord(db.prepare(`
    SELECT COUNT(*) AS uncoveredChanges
    FROM replication_canonical_changes
    WHERE entity_type NOT IN (${coveredPlaceholders})
  `).get(...REPLICATION_JOURNAL_GC_COVERED_ENTITY_TYPES)), 'uncoveredChanges')

  return {
    available: true,
    highWaterRevision,
    safeJournalRevision,
    oldestRetainedRevision,
    retainedChanges,
    reclaimableChanges,
    uncoveredChanges,
    gcCoveredEntityTypes: [...REPLICATION_JOURNAL_GC_COVERED_ENTITY_TYPES],
    dependentRoots: dependencies.length,
    blockingStreams: dependencies
      .filter(item => item.capturedRevision < highWaterRevision)
      .sort((a, b) =>
        a.capturedRevision - b.capturedRevision
        || a.streamId.localeCompare(b.streamId)
        || a.entityType.localeCompare(b.entityType)),
  }
}

export class SqliteReplicationJournalLifecycleRepository {
  constructor(private readonly executor: SqliteExecutor) {}

  async highWaterRevision(): Promise<number> {
    return this.executor.run(() => persistentHighWater(this.executor.db))
  }

  async get(input: {
    streamId: string
    generationId: string
    entityType: KnownReplicationEntityType
  }): Promise<ReplicationCaptureWatermark | null> {
    return this.executor.run(() => {
      const row = this.executor.db.prepare(`
        SELECT stream_id AS streamId,
               generation_id AS generationId,
               entity_type AS entityType,
               captured_revision AS capturedRevision,
               dependency_state AS dependencyState,
               updated_at AS updatedAt
        FROM replication_capture_watermarks
        WHERE stream_id = ? AND generation_id = ? AND entity_type = ?
      `).get(input.streamId, input.generationId, input.entityType)
      return row ? mapCaptureWatermark(row) : null
    })
  }

  async advance(input: {
    streamId: string
    generationId: string
    entityType: KnownReplicationEntityType
    capturedRevision: number
    now?: string
  }): Promise<ReplicationCaptureWatermark> {
    if (!Number.isInteger(input.capturedRevision) || input.capturedRevision < 0) {
      throw new TypeError('capturedRevision must be a non-negative integer')
    }
    return this.executor.transaction(async () => {
      const stream = this.executor.db.prepare(`
        SELECT generation_id AS generationId FROM replication_streams WHERE stream_id = ?
      `).get(input.streamId)
      if (!stream) throw new Error(`Replication stream not found: ${input.streamId}`)
      if (requiredString(rowRecord(stream), 'generationId') !== input.generationId) {
        throw new Error('Replication capture watermark generation does not match stream')
      }
      const highWaterRevision = persistentHighWater(this.executor.db)
      if (input.capturedRevision > highWaterRevision) {
        throw new Error('Replication capture watermark cannot advance beyond journal high-water')
      }
      const existing = await this.get(input)
      if (existing?.dependencyState === 'retired') {
        throw new Error('Retired replication capture dependency requires explicit re-bootstrap')
      }
      if (existing && input.capturedRevision < existing.capturedRevision) {
        throw new Error('Replication capture watermark cannot move backwards')
      }
      if (existing && input.capturedRevision === existing.capturedRevision) return existing

      const state: ReplicationCaptureWatermark = {
        streamId: input.streamId,
        generationId: input.generationId,
        entityType: input.entityType,
        capturedRevision: input.capturedRevision,
        dependencyState: 'dependent',
        updatedAt: input.now ?? new Date().toISOString(),
      }
      this.executor.db.prepare(`
        INSERT INTO replication_capture_watermarks(
          stream_id, generation_id, entity_type, captured_revision, dependency_state, updated_at
        ) VALUES (?, ?, ?, ?, 'dependent', ?)
        ON CONFLICT(stream_id, generation_id, entity_type) DO UPDATE SET
          captured_revision = excluded.captured_revision,
          dependency_state = 'dependent',
          updated_at = excluded.updated_at
      `).run(state.streamId, state.generationId, state.entityType, state.capturedRevision, state.updatedAt)
      return state
    })
  }

  async retire(input: {
    streamId: string
    generationId: string
    entityType: KnownReplicationEntityType
    now?: string
  }): Promise<ReplicationCaptureWatermark> {
    return this.executor.transaction(async () => {
      const stream = this.executor.db.prepare(`
        SELECT generation_id AS generationId FROM replication_streams WHERE stream_id = ?
      `).get(input.streamId)
      if (!stream) throw new Error(`Replication stream not found: ${input.streamId}`)
      if (requiredString(rowRecord(stream), 'generationId') !== input.generationId) {
        throw new Error('Replication capture watermark generation does not match stream')
      }
      const existing = await this.get(input)
      const state: ReplicationCaptureWatermark = {
        streamId: input.streamId,
        generationId: input.generationId,
        entityType: input.entityType,
        capturedRevision: existing?.capturedRevision ?? 0,
        dependencyState: 'retired',
        updatedAt: input.now ?? new Date().toISOString(),
      }
      this.executor.db.prepare(`
        INSERT INTO replication_capture_watermarks(
          stream_id, generation_id, entity_type, captured_revision, dependency_state, updated_at
        ) VALUES (?, ?, ?, ?, 'retired', ?)
        ON CONFLICT(stream_id, generation_id, entity_type) DO UPDATE SET
          dependency_state = 'retired',
          updated_at = excluded.updated_at
      `).run(state.streamId, state.generationId, state.entityType, state.capturedRevision, state.updatedAt)
      return state
    })
  }

  async retireGeneration(input: {
    streamId: string
    generationId: string
    now?: string
  }): Promise<number> {
    return this.executor.transaction(async () => {
      const stream = this.executor.db.prepare(`
        SELECT generation_id AS generationId
        FROM replication_streams
        WHERE stream_id = ?
      `).get(input.streamId)
      if (!stream) throw new Error(`Replication stream not found: ${input.streamId}`)
      if (requiredString(rowRecord(stream), 'generationId') !== input.generationId) {
        throw new Error('Replication capture retirement generation does not match stream')
      }
      const now = input.now ?? new Date().toISOString()
      const result = this.executor.db.prepare(`
        UPDATE replication_capture_watermarks
        SET dependency_state = 'retired',
            updated_at = ?
        WHERE stream_id = ?
          AND generation_id = ?
          AND dependency_state <> 'retired'
      `).run(now, input.streamId, input.generationId)
      return result.changes
    })
  }

  async safety(): Promise<ReplicationJournalSafety> {
    return this.executor.run(() => replicationJournalSafetyDetails(this.executor.db))
  }

  async reclaimBatch(input: { limit?: number } = {}): Promise<{
    deletedChanges: number
    deletedThroughRevision: number | null
    highWaterRevision: number
    safeJournalRevision: number
  }> {
    const limit = Math.max(1, Math.min(input.limit ?? 1000, 10_000))
    return this.executor.transaction(async () => {
      const safety = replicationJournalSafetyDetails(this.executor.db)
      if (!safety.available || safety.reclaimableChanges === 0) {
        return {
          deletedChanges: 0,
          deletedThroughRevision: null,
          highWaterRevision: safety.highWaterRevision,
          safeJournalRevision: safety.safeJournalRevision,
        }
      }
      const boundary = nullableNumber(rowRecord(this.executor.db.prepare(`
        SELECT MAX(revision) AS boundary
        FROM (
          SELECT revision
          FROM replication_canonical_changes
          WHERE entity_type IN (${REPLICATION_JOURNAL_GC_COVERED_ENTITY_TYPES.map(() => '?').join(', ')})
            AND revision <= ?
          ORDER BY revision
          LIMIT ?
        )
      `).get(...REPLICATION_JOURNAL_GC_COVERED_ENTITY_TYPES, safety.safeJournalRevision, limit)), 'boundary')
      if (boundary === null) {
        return {
          deletedChanges: 0,
          deletedThroughRevision: null,
          highWaterRevision: safety.highWaterRevision,
          safeJournalRevision: safety.safeJournalRevision,
        }
      }
      const result = this.executor.db.prepare(`
        DELETE FROM replication_canonical_changes
        WHERE entity_type IN (${REPLICATION_JOURNAL_GC_COVERED_ENTITY_TYPES.map(() => '?').join(', ')})
          AND revision <= ?
      `).run(...REPLICATION_JOURNAL_GC_COVERED_ENTITY_TYPES, boundary)
      return {
        deletedChanges: result.changes,
        deletedThroughRevision: boundary,
        highWaterRevision: safety.highWaterRevision,
        safeJournalRevision: safety.safeJournalRevision,
      }
    })
  }
}
