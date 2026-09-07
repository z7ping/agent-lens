import type {
  ObservationRepository,
  SourceRecordReplayCursor,
  SourceRecordRepository,
} from '@agent-lens/core'
import type { SqliteExecutor } from './executor'
import { sqliteRowId } from './repository-row-mappers'

const PARSER_REPLAY_CHECKPOINT_SCOPE = 'parser-replay'

type ReplayDbRow = Record<string, unknown>

interface DerivedRelationshipRow {
  fromLogicalSessionId: string | null
  toLogicalSessionId: string | null
  relationType: string
}

interface ReplayRow {
  id: string
  capturedAt: string
  parserVersion: string
}

function rowRecord(value: unknown): ReplayDbRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Parser Replay SQLite query returned a non-object row')
  }
  return value as ReplayDbRow
}

function requiredString(row: ReplayDbRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new TypeError(`Parser Replay SQLite field ${key} must be a string`)
  return value
}

function nullableString(row: ReplayDbRow, key: string): string | null {
  const value = row[key]
  if (value == null) return null
  if (typeof value !== 'string') throw new TypeError(`Parser Replay SQLite field ${key} must be a string or null`)
  return value
}

function relationshipRow(value: unknown): DerivedRelationshipRow {
  const row = rowRecord(value)
  return {
    fromLogicalSessionId: nullableString(row, 'fromLogicalSessionId'),
    toLogicalSessionId: nullableString(row, 'toLogicalSessionId'),
    relationType: requiredString(row, 'relationType'),
  }
}

function replayRow(value: unknown): ReplayRow {
  const row = rowRecord(value)
  return {
    id: requiredString(row, 'id'),
    capturedAt: requiredString(row, 'capturedAt'),
    parserVersion: requiredString(row, 'parserVersion'),
  }
}

function parserVersionRow(value: unknown): string {
  return requiredString(rowRecord(value), 'parserVersion')
}

/**
 * Parser replay 必须替换同一 SourceRecord 的旧 Canonical 派生，而不是简单追加。
 *
 * Observation：删除 Observation -> Evidence 的派生链接，并删除因此失去全部证据的 Observation。
 * Relationship：删除该 SourceRecord 产生的 relationship candidate；若对应 canonical relationship
 * 已没有任何其他 candidate 支持，也一并删除。
 *
 * SourceRecord、Evidence、locator 和原始 payload 全部保留。若一个 Observation/Relationship
 * 同时有其他来源支持，它会继续存活。
 *
 * Observation 允许通过 parent_observation_id 组成事件树。删除失去全部证据的父节点前，
 * 必须先断开仍存活子节点的物理外键；native_parent_event_id 会继续保留，父节点在 replay
 * 中重新生成后会由 ObservationService.linkChildrenToParent 恢复关系。
 */
export function withSqliteParserReplayReplacement(
  executor: SqliteExecutor,
  sourceRecords: SourceRecordRepository,
  observations: ObservationRepository,
): { sourceRecords: SourceRecordRepository; observations: ObservationRepository } {
  const replayAwareObservations: ObservationRepository = {
    ...observations,
    async removeDerivationsForSourceRecord(sourceRecordId) {
      return executor.transaction(async () => {
        const rows = executor.db.prepare(`
          SELECT DISTINCT oe.observation_id AS id
          FROM observation_evidence oe
          JOIN evidence e ON e.id = oe.evidence_id
          WHERE e.source_record_id = ?
        `).all(sourceRecordId).map(sqliteRowId)
        if (!rows.length) return 0

        executor.db.prepare(`
          DELETE FROM observation_evidence
          WHERE evidence_id IN (
            SELECT id FROM evidence WHERE source_record_id = ?
          )
        `).run(sourceRecordId)

        const hasEvidence = executor.db.prepare(`
          SELECT 1
          FROM observation_evidence
          WHERE observation_id = ?
          LIMIT 1
        `)
        const detachChildren = executor.db.prepare(`
          UPDATE observations
          SET parent_observation_id = NULL
          WHERE parent_observation_id = ?
        `)
        const remove = executor.db.prepare('DELETE FROM observations WHERE id = ?')

        let removed = 0
        for (const id of rows) {
          if (hasEvidence.get(id)) continue
          detachChildren.run(id)
          removed += Number(remove.run(id).changes)
        }
        return removed
      })
    },
  }

  async function removeRelationshipDerivationsForSourceRecord(sourceRecordId: string): Promise<number> {
    return executor.transaction(async () => {
      const candidates = executor.db.prepare(`
        SELECT DISTINCT
          from_ss.logical_session_id AS fromLogicalSessionId,
          to_ss.logical_session_id AS toLogicalSessionId,
          COALESCE(c.relation_type, 'related') AS relationType
        FROM session_relationship_candidates c
        LEFT JOIN source_sessions from_ss
          ON from_ss.source_id = c.source_id
         AND from_ss.installation_id = c.installation_id
         AND from_ss.native_session_id = c.from_native_session_id
        LEFT JOIN source_sessions to_ss
          ON to_ss.source_id = c.source_id
         AND to_ss.installation_id = c.installation_id
         AND to_ss.native_session_id = c.to_native_session_id
        WHERE c.source_record_id = ?
      `).all(sourceRecordId).map(relationshipRow)

      const deletedCandidates = Number(executor.db.prepare(`
        DELETE FROM session_relationship_candidates
        WHERE source_record_id = ?
      `).run(sourceRecordId).changes)

      if (!candidates.length) return deletedCandidates

      const hasRemainingSupport = executor.db.prepare(`
        SELECT 1
        FROM session_relationship_candidates c
        JOIN source_sessions from_ss
          ON from_ss.source_id = c.source_id
         AND from_ss.installation_id = c.installation_id
         AND from_ss.native_session_id = c.from_native_session_id
        JOIN source_sessions to_ss
          ON to_ss.source_id = c.source_id
         AND to_ss.installation_id = c.installation_id
         AND to_ss.native_session_id = c.to_native_session_id
        WHERE from_ss.logical_session_id = ?
          AND to_ss.logical_session_id = ?
          AND COALESCE(c.relation_type, 'related') = ?
        LIMIT 1
      `)
      const removeRelationship = executor.db.prepare(`
        DELETE FROM session_relationships
        WHERE from_session_id = ? AND to_session_id = ? AND type = ?
      `)

      let removedRelationships = 0
      for (const candidate of candidates) {
        const fromSessionId = candidate.fromLogicalSessionId
        const toSessionId = candidate.toLogicalSessionId
        if (!fromSessionId || !toSessionId) continue
        if (hasRemainingSupport.get(fromSessionId, toSessionId, candidate.relationType)) continue
        removedRelationships += Number(
          removeRelationship.run(fromSessionId, toSessionId, candidate.relationType).changes,
        )
      }
      return deletedCandidates + removedRelationships
    })
  }

  function replayWindow(
    sourceId: string,
    installationId: string,
    window?: { activeSince?: string; sessionLimit?: number },
  ): { clause: string; params: unknown[] } {
    const activeSince = window?.activeSince
    const sessionLimit = window?.sessionLimit
    if (!activeSince && !sessionLimit) return { clause: '', params: [] }
    return {
      clause: `AND source_session_native_id IN (
        SELECT source_session_native_id FROM source_records
        WHERE source_id = ? AND installation_id = ? AND source_session_native_id IS NOT NULL
        ${activeSince ? 'AND captured_at >= ?' : ''}
        GROUP BY source_session_native_id
        ORDER BY MAX(captured_at) DESC
        ${sessionLimit ? 'LIMIT ?' : ''}
      )`,
      params: [
        sourceId,
        installationId,
        ...(activeSince ? [activeSince] : []),
        ...(sessionLimit ? [sessionLimit] : []),
      ],
    }
  }

  async function replayPage(
    sourceId: string,
    installationId: string,
    parserVersion: string,
    after: SourceRecordReplayCursor | undefined,
    limit: number,
    window?: { activeSince?: string; sessionLimit?: number },
  ): Promise<ReplayRow[]> {
    return executor.run(() => {
      const filter = replayWindow(sourceId, installationId, window)
      const cursor = after
        ? 'AND (captured_at, id) > (?, ?)'
        : ''
      const params: unknown[] = [sourceId, installationId, parserVersion]
      if (after) params.push(after.capturedAt, after.id)
      params.push(...filter.params, limit)
      return executor.db.prepare(`
        SELECT id, captured_at AS capturedAt, parser_version AS parserVersion
        FROM source_records
        WHERE source_id = ? AND installation_id = ? AND parser_version = ?
        ${cursor}
        ${filter.clause}
        ORDER BY captured_at ASC, id ASC
        LIMIT ?
      `).all(...params).map(replayRow)
    })
  }

  async function nextReplayParserVersion(
    sourceId: string,
    installationId: string,
    currentParserVersion: string,
    window?: { activeSince?: string; sessionLimit?: number },
  ): Promise<string | undefined> {
    return executor.run(() => {
      const filter = replayWindow(sourceId, installationId, window)
      const row = executor.db.prepare(`
        SELECT parser_version AS parserVersion
        FROM source_records
        WHERE source_id = ? AND installation_id = ? AND parser_version != ?
        ${filter.clause}
        ORDER BY parser_version ASC
        LIMIT 1
      `).get(sourceId, installationId, currentParserVersion, ...filter.params)
      return row ? parserVersionRow(row) : undefined
    })
  }

  async function markReplayCheckpointsDirty(record: {
    sourceId: string
    installationId: string
    parserVersion: string
  }): Promise<void> {
    await executor.run(() => {
      const updatedAt = new Date().toISOString()
      executor.db.prepare(`
        UPDATE source_checkpoints
        SET value_json = json_remove(
              json_set(
                value_json,
                '$.state', 'pending',
                '$.dirty', json('true'),
                '$.updatedAt', ?
              ),
              '$.cursor',
              '$.completedAt'
            ),
            updated_at = ?
        WHERE scope = ?
          AND json_extract(value_json, '$.sourceId') = ?
          AND json_extract(value_json, '$.installationId') = ?
          AND json_extract(value_json, '$.targetParserVersion') != ?
      `).run(
        updatedAt,
        updatedAt,
        PARSER_REPLAY_CHECKPOINT_SCOPE,
        record.sourceId,
        record.installationId,
        record.parserVersion,
      )
    })
  }

  const replayAwareSourceRecords: SourceRecordRepository = {
    ...sourceRecords,
    async listForParserReplay(sourceId, installationId, currentParserVersion, after, limit = 500, window) {
      const pageLimit = Math.max(1, Math.min(limit, 2000))
      let parserVersion = after?.parserVersion
      let rows = parserVersion
        ? await replayPage(sourceId, installationId, parserVersion, after, pageLimit, window)
        : []

      if (!rows.length) {
        parserVersion = await nextReplayParserVersion(sourceId, installationId, currentParserVersion, window)
        if (!parserVersion) return []
        const sameVersionCursor = after?.parserVersion === parserVersion ? after : undefined
        rows = await replayPage(
          sourceId,
          installationId,
          parserVersion,
          sameVersionCursor,
          pageLimit,
          window,
        )
      }
      if (!rows.length) return []

      const ids = rows.map(row => row.id)
      const records = sourceRecords.getMany
        ? await sourceRecords.getMany(ids)
        : (await Promise.all(ids.map(id => sourceRecords.get(id)))).filter(item => item != null)
      const byId = new Map(records.map(record => [record.id, record]))
      return ids.flatMap(id => {
        const record = byId.get(id)
        return record ? [record] : []
      })
    },
    async put(record) {
      const existing = await sourceRecords.get(record.id)
      if (existing && existing.parserVersion !== record.parserVersion) {
        await replayAwareObservations.removeDerivationsForSourceRecord?.(record.id)
        await removeRelationshipDerivationsForSourceRecord(record.id)
      }
      await sourceRecords.put(record)
      await markReplayCheckpointsDirty(record)
    },
  }

  return {
    sourceRecords: replayAwareSourceRecords,
    observations: replayAwareObservations,
  }
}
