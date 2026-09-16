import type {
  HistoryBoundary,
  KnownReplicationEntityType,
  ReplicationPolicy,
  ReplicationStreamState,
} from '@agent-lens/core/replication'
import type { SqliteExecutor } from './executor'
import { streamRow } from './replication-state-rows'

export interface ReplicationStreamAuthorization {
  streamId: string
  generationId: string
  policy: ReplicationPolicy
  history: HistoryBoundary
  updatedAt: string
}

export interface RunnableReplicationStream {
  stream: ReplicationStreamState
  authorization: ReplicationStreamAuthorization
}

export interface ReplicationReconciliationCycle {
  streamId: string
  generationId: string
  entityType: KnownReplicationEntityType
  cycle: number
  status: 'idle' | 'running'
  throughRevision: number
  startedAt?: string
  completedAt?: string
  nextDueAt?: string
  updatedAt: string
}

export type BeginReplicationReconciliationCycleResult =
  | { kind: 'running'; cycle: ReplicationReconciliationCycle }
  | { kind: 'not-due'; nextDueAt: string }

type Row = Record<string, unknown>

function rowRecord(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Replication runtime control row must be an object')
  }
  return value as Row
}
function requiredString(row: Row, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new TypeError(`Replication runtime field ${key} must be a string`)
  return value
}
function optionalString(row: Row, key: string): string | undefined {
  const value = row[key]
  if (value == null) return undefined
  if (typeof value !== 'string') throw new TypeError(`Replication runtime field ${key} must be a string or null`)
  return value
}
function requiredNumber(row: Row, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Replication runtime field ${key} must be a finite number`)
  }
  return value
}

function mapAuthorization(value: unknown): ReplicationStreamAuthorization {
  const row = rowRecord(value)
  const policyMode = requiredString(row, 'policyMode')
  if (policyMode !== 'metadata-only' && policyMode !== 'redacted' && policyMode !== 'full') {
    throw new TypeError(`Unsupported replication policy mode: ${policyMode}`)
  }
  const historyMode = requiredString(row, 'historyMode')
  if (historyMode !== 'include-existing' && historyMode !== 'from-now') {
    throw new TypeError(`Unsupported replication history mode: ${historyMode}`)
  }
  const boundaryCapturedAt = optionalString(row, 'boundaryCapturedAt')
  return {
    streamId: requiredString(row, 'streamId'),
    generationId: requiredString(row, 'generationId'),
    policy: {
      mode: policyMode,
      revision: requiredString(row, 'policyRevision'),
    },
    history: {
      mode: historyMode,
      revision: requiredString(row, 'historyRevision'),
      ...(boundaryCapturedAt === undefined ? {} : { boundaryCapturedAt }),
    },
    updatedAt: requiredString(row, 'updatedAt'),
  }
}

function mapCycle(value: unknown): ReplicationReconciliationCycle {
  const row = rowRecord(value)
  const status = requiredString(row, 'status')
  if (status !== 'idle' && status !== 'running') {
    throw new TypeError(`Unsupported reconciliation cycle status: ${status}`)
  }
  const startedAt = optionalString(row, 'startedAt')
  const completedAt = optionalString(row, 'completedAt')
  const nextDueAt = optionalString(row, 'nextDueAt')
  return {
    streamId: requiredString(row, 'streamId'),
    generationId: requiredString(row, 'generationId'),
    entityType: requiredString(row, 'entityType') as KnownReplicationEntityType,
    cycle: requiredNumber(row, 'cycle'),
    status,
    throughRevision: requiredNumber(row, 'throughRevision'),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(nextDueAt === undefined ? {} : { nextDueAt }),
    updatedAt: requiredString(row, 'updatedAt'),
  }
}

export class SqliteReplicationRuntimeControlRepository {
  constructor(private readonly executor: SqliteExecutor) {}

  async putAuthorization(input: {
    streamId: string
    generationId: string
    policy: ReplicationPolicy
    history: HistoryBoundary
    now?: string
  }): Promise<ReplicationStreamAuthorization> {
    if (
      input.history.mode === 'from-now'
      && (!input.history.boundaryCapturedAt || !Number.isFinite(Date.parse(input.history.boundaryCapturedAt)))
    ) {
      throw new Error('from-now replication authorization requires a valid boundaryCapturedAt')
    }
    if (input.history.mode === 'include-existing' && input.history.boundaryCapturedAt !== undefined) {
      throw new Error('include-existing replication authorization must not persist boundaryCapturedAt')
    }

    return this.executor.transaction(async () => {
      const streamValue = this.executor.db.prepare(`
        SELECT relationship_id AS relationshipId,
               hub_id AS hubId,
               stream_id AS streamId,
               generation_id AS generationId,
               status,
               next_sequence AS nextSequence,
               ack_sequence AS ackSequence,
               policy_revision AS policyRevision,
               history_revision AS historyRevision,
               created_at AS createdAt,
               updated_at AS updatedAt
        FROM replication_streams
        WHERE stream_id = ?
      `).get(input.streamId)
      if (!streamValue) throw new Error(`Replication stream not found: ${input.streamId}`)
      const stream = streamRow(streamValue)
      if (stream.generationId !== input.generationId) {
        throw new Error('Replication authorization generation does not match stream')
      }
      if (
        stream.policyRevision !== input.policy.revision
        || stream.historyRevision !== input.history.revision
      ) {
        throw new Error('Replication authorization revision does not match stream')
      }

      const updatedAt = input.now ?? new Date().toISOString()
      this.executor.db.prepare(`
        INSERT INTO replication_stream_authorizations(
          stream_id, generation_id,
          policy_mode, policy_revision,
          history_mode, history_revision,
          boundary_captured_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(stream_id) DO UPDATE SET
          generation_id = excluded.generation_id,
          policy_mode = excluded.policy_mode,
          policy_revision = excluded.policy_revision,
          history_mode = excluded.history_mode,
          history_revision = excluded.history_revision,
          boundary_captured_at = excluded.boundary_captured_at,
          updated_at = excluded.updated_at
      `).run(
        input.streamId,
        input.generationId,
        input.policy.mode,
        input.policy.revision,
        input.history.mode,
        input.history.revision,
        input.history.boundaryCapturedAt ?? null,
        updatedAt,
      )
      return {
        streamId: input.streamId,
        generationId: input.generationId,
        policy: { ...input.policy },
        history: { ...input.history },
        updatedAt,
      }
    })
  }

  async getAuthorization(streamId: string): Promise<ReplicationStreamAuthorization | null> {
    return this.executor.run(() => {
      const row = this.executor.db.prepare(`
        SELECT stream_id AS streamId,
               generation_id AS generationId,
               policy_mode AS policyMode,
               policy_revision AS policyRevision,
               history_mode AS historyMode,
               history_revision AS historyRevision,
               boundary_captured_at AS boundaryCapturedAt,
               updated_at AS updatedAt
        FROM replication_stream_authorizations
        WHERE stream_id = ?
      `).get(streamId)
      return row ? mapAuthorization(row) : null
    })
  }

  async listRunnableStreams(): Promise<RunnableReplicationStream[]> {
    return this.executor.run(() => this.executor.db.prepare(`
      SELECT s.relationship_id AS relationshipId,
             s.hub_id AS hubId,
             s.stream_id AS streamId,
             s.generation_id AS generationId,
             s.status,
             s.next_sequence AS nextSequence,
             s.ack_sequence AS ackSequence,
             s.policy_revision AS policyRevision,
             s.history_revision AS historyRevision,
             s.created_at AS createdAt,
             s.updated_at AS updatedAt,
             a.policy_mode AS authorizationPolicyMode,
             a.policy_revision AS authorizationPolicyRevision,
             a.history_mode AS authorizationHistoryMode,
             a.history_revision AS authorizationHistoryRevision,
             a.boundary_captured_at AS authorizationBoundaryCapturedAt,
             a.updated_at AS authorizationUpdatedAt
      FROM replication_streams s
      JOIN replication_stream_authorizations a ON a.stream_id = s.stream_id
      WHERE s.status = 'active'
        AND a.generation_id = s.generation_id
        AND a.policy_revision = s.policy_revision
        AND a.history_revision = s.history_revision
      ORDER BY s.created_at, s.stream_id
    `).all().map(value => {
      const row = rowRecord(value)
      const stream = streamRow(value)
      return {
        stream,
        authorization: mapAuthorization({
          streamId: stream.streamId,
          generationId: stream.generationId,
          policyMode: requiredString(row, 'authorizationPolicyMode'),
          policyRevision: requiredString(row, 'authorizationPolicyRevision'),
          historyMode: requiredString(row, 'authorizationHistoryMode'),
          historyRevision: requiredString(row, 'authorizationHistoryRevision'),
          boundaryCapturedAt: optionalString(row, 'authorizationBoundaryCapturedAt') ?? null,
          updatedAt: requiredString(row, 'authorizationUpdatedAt'),
        }),
      }
    }))
  }

  async beginReconciliationCycle(input: {
    streamId: string
    generationId: string
    entityType: KnownReplicationEntityType
    throughRevision: number
    now?: string
  }): Promise<BeginReplicationReconciliationCycleResult> {
    if (!Number.isInteger(input.throughRevision) || input.throughRevision < 0) {
      throw new TypeError('Reconciliation throughRevision must be a non-negative integer')
    }
    return this.executor.transaction(async () => {
      const now = input.now ?? new Date().toISOString()
      const existingRow = this.executor.db.prepare(`
        SELECT stream_id AS streamId,
               generation_id AS generationId,
               entity_type AS entityType,
               cycle,
               status,
               through_revision AS throughRevision,
               started_at AS startedAt,
               completed_at AS completedAt,
               next_due_at AS nextDueAt,
               updated_at AS updatedAt
        FROM replication_reconciliation_cycles
        WHERE stream_id = ? AND generation_id = ? AND entity_type = ?
      `).get(input.streamId, input.generationId, input.entityType)
      const existing = existingRow ? mapCycle(existingRow) : null
      if (existing?.status === 'running') return { kind: 'running', cycle: existing }
      if (
        existing?.nextDueAt
        && Date.parse(existing.nextDueAt) > Date.parse(now)
      ) {
        return { kind: 'not-due', nextDueAt: existing.nextDueAt }
      }

      const stream = this.executor.db.prepare(`
        SELECT generation_id AS generationId, status
        FROM replication_streams
        WHERE stream_id = ?
      `).get(input.streamId)
      if (!stream) throw new Error(`Replication stream not found: ${input.streamId}`)
      const streamRecord = rowRecord(stream)
      if (requiredString(streamRecord, 'generationId') !== input.generationId) {
        throw new Error('Reconciliation cycle generation does not match stream')
      }
      if (requiredString(streamRecord, 'status') !== 'active') {
        throw new Error('Reconciliation cycle requires an active stream')
      }

      this.executor.db.prepare(`
        DELETE FROM replication_reconciliation_cursors
        WHERE stream_id = ? AND entity_type = ?
      `).run(input.streamId, input.entityType)

      const cycle: ReplicationReconciliationCycle = {
        streamId: input.streamId,
        generationId: input.generationId,
        entityType: input.entityType,
        cycle: (existing?.cycle ?? 0) + 1,
        status: 'running',
        throughRevision: input.throughRevision,
        startedAt: now,
        updatedAt: now,
      }
      this.executor.db.prepare(`
        INSERT INTO replication_reconciliation_cycles(
          stream_id, generation_id, entity_type, cycle, status,
          through_revision, started_at, completed_at, next_due_at, updated_at
        ) VALUES (?, ?, ?, ?, 'running', ?, ?, NULL, NULL, ?)
        ON CONFLICT(stream_id, generation_id, entity_type) DO UPDATE SET
          cycle = excluded.cycle,
          status = 'running',
          through_revision = excluded.through_revision,
          started_at = excluded.started_at,
          completed_at = NULL,
          next_due_at = NULL,
          updated_at = excluded.updated_at
      `).run(
        cycle.streamId,
        cycle.generationId,
        cycle.entityType,
        cycle.cycle,
        cycle.throughRevision,
        cycle.startedAt,
        cycle.updatedAt,
      )
      return { kind: 'running', cycle }
    })
  }

  async completeReconciliationCycle(input: {
    streamId: string
    generationId: string
    entityType: KnownReplicationEntityType
    nextDueAt: string
    now?: string
  }): Promise<ReplicationReconciliationCycle> {
    return this.executor.transaction(async () => {
      const existing = await this.getReconciliationCycle(input)
      if (!existing || existing.status !== 'running') {
        throw new Error('No running reconciliation cycle to complete')
      }
      const now = input.now ?? new Date().toISOString()
      this.executor.db.prepare(`
        UPDATE replication_reconciliation_cycles
        SET status = 'idle',
            completed_at = ?,
            next_due_at = ?,
            updated_at = ?
        WHERE stream_id = ? AND generation_id = ? AND entity_type = ?
      `).run(
        now,
        input.nextDueAt,
        now,
        input.streamId,
        input.generationId,
        input.entityType,
      )
      return {
        ...existing,
        status: 'idle',
        completedAt: now,
        nextDueAt: input.nextDueAt,
        updatedAt: now,
      }
    })
  }

  async getReconciliationCycle(input: {
    streamId: string
    generationId: string
    entityType: KnownReplicationEntityType
  }): Promise<ReplicationReconciliationCycle | null> {
    return this.executor.run(() => {
      const row = this.executor.db.prepare(`
        SELECT stream_id AS streamId,
               generation_id AS generationId,
               entity_type AS entityType,
               cycle,
               status,
               through_revision AS throughRevision,
               started_at AS startedAt,
               completed_at AS completedAt,
               next_due_at AS nextDueAt,
               updated_at AS updatedAt
        FROM replication_reconciliation_cycles
        WHERE stream_id = ? AND generation_id = ? AND entity_type = ?
      `).get(input.streamId, input.generationId, input.entityType)
      return row ? mapCycle(row) : null
    })
  }
}
