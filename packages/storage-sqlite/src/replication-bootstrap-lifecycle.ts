import type { KnownReplicationEntityType } from '@agent-lens/core/replication'
import type { SqliteExecutor } from './executor'

export const REPLICATION_BOOTSTRAP_STAGES = [
  'staged',
  'snapshot',
  'delta',
  'reconcile',
  'active',
] as const

export type ReplicationBootstrapStage = typeof REPLICATION_BOOTSTRAP_STAGES[number]

export interface ReplicationBootstrapGenerationState {
  streamId: string
  generationId: string
  entityType: KnownReplicationEntityType
  stage: ReplicationBootstrapStage
  policyRevision: string
  historyRevision: string
  updatedAt: string
}

type Row = Record<string, unknown>

function rowRecord(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Replication bootstrap lifecycle row must be an object')
  }
  return value as Row
}

function requiredString(row: Row, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') {
    throw new TypeError(`Replication bootstrap lifecycle field ${key} must be a string`)
  }
  return value
}

function mapState(value: unknown): ReplicationBootstrapGenerationState {
  const row = rowRecord(value)
  const stage = requiredString(row, 'stage')
  if (!(REPLICATION_BOOTSTRAP_STAGES as readonly string[]).includes(stage)) {
    throw new TypeError(`Unsupported replication bootstrap stage: ${stage}`)
  }
  return {
    streamId: requiredString(row, 'streamId'),
    generationId: requiredString(row, 'generationId'),
    entityType: requiredString(row, 'entityType') as KnownReplicationEntityType,
    stage: stage as ReplicationBootstrapStage,
    policyRevision: requiredString(row, 'policyRevision'),
    historyRevision: requiredString(row, 'historyRevision'),
    updatedAt: requiredString(row, 'updatedAt'),
  }
}

function stageIndex(stage: ReplicationBootstrapStage): number {
  return REPLICATION_BOOTSTRAP_STAGES.indexOf(stage)
}

export class SqliteReplicationBootstrapLifecycleRepository {
  constructor(private readonly executor: SqliteExecutor) {}

  async get(input: {
    streamId: string
    generationId: string
    entityType: KnownReplicationEntityType
  }): Promise<ReplicationBootstrapGenerationState | null> {
    return this.executor.run(() => {
      const row = this.executor.db.prepare(`
        SELECT stream_id AS streamId,
               generation_id AS generationId,
               entity_type AS entityType,
               stage,
               policy_revision AS policyRevision,
               history_revision AS historyRevision,
               updated_at AS updatedAt
        FROM replication_bootstrap_generations
        WHERE stream_id = ? AND generation_id = ? AND entity_type = ?
      `).get(input.streamId, input.generationId, input.entityType)
      return row ? mapState(row) : null
    })
  }

  async ensure(input: {
    streamId: string
    generationId: string
    entityType: KnownReplicationEntityType
    policyRevision: string
    historyRevision: string
    now?: string
  }): Promise<ReplicationBootstrapGenerationState> {
    return this.executor.transaction(async () => {
      const stream = this.executor.db.prepare(`
        SELECT generation_id AS generationId
        FROM replication_streams
        WHERE stream_id = ?
      `).get(input.streamId)
      if (!stream) throw new Error(`Replication stream not found: ${input.streamId}`)
      if (requiredString(rowRecord(stream), 'generationId') !== input.generationId) {
        throw new Error('Replication bootstrap lifecycle generation does not match stream')
      }

      const existing = await this.get(input)
      if (existing) {
        if (
          existing.policyRevision !== input.policyRevision
          || existing.historyRevision !== input.historyRevision
        ) {
          throw new Error('Replication bootstrap lifecycle policy/history revision changed; re-bootstrap is required')
        }
        return existing
      }

      const state: ReplicationBootstrapGenerationState = {
        streamId: input.streamId,
        generationId: input.generationId,
        entityType: input.entityType,
        stage: 'staged',
        policyRevision: input.policyRevision,
        historyRevision: input.historyRevision,
        updatedAt: input.now ?? new Date().toISOString(),
      }
      this.executor.db.prepare(`
        INSERT INTO replication_bootstrap_generations(
          stream_id, generation_id, entity_type, stage,
          policy_revision, history_revision, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        state.streamId,
        state.generationId,
        state.entityType,
        state.stage,
        state.policyRevision,
        state.historyRevision,
        state.updatedAt,
      )
      return state
    })
  }

  async transition(input: {
    streamId: string
    generationId: string
    entityType: KnownReplicationEntityType
    stage: ReplicationBootstrapStage
    policyRevision: string
    historyRevision: string
    now?: string
  }): Promise<ReplicationBootstrapGenerationState> {
    return this.executor.transaction(async () => {
      const existing = await this.get(input)
      if (!existing) {
        throw new Error('Replication bootstrap lifecycle must be initialized before transition')
      }
      if (
        existing.policyRevision !== input.policyRevision
        || existing.historyRevision !== input.historyRevision
      ) {
        throw new Error('Replication bootstrap lifecycle policy/history revision changed; re-bootstrap is required')
      }
      const currentIndex = stageIndex(existing.stage)
      const nextIndex = stageIndex(input.stage)
      if (nextIndex < currentIndex) {
        throw new Error('Replication bootstrap lifecycle cannot move backwards')
      }
      if (nextIndex > currentIndex + 1) {
        throw new Error('Replication bootstrap lifecycle cannot skip stages')
      }
      if (nextIndex === currentIndex) return existing

      const state: ReplicationBootstrapGenerationState = {
        ...existing,
        stage: input.stage,
        updatedAt: input.now ?? new Date().toISOString(),
      }
      this.executor.db.prepare(`
        UPDATE replication_bootstrap_generations
        SET stage = ?, updated_at = ?
        WHERE stream_id = ? AND generation_id = ? AND entity_type = ?
      `).run(
        state.stage,
        state.updatedAt,
        state.streamId,
        state.generationId,
        state.entityType,
      )
      return state
    })
  }
}
