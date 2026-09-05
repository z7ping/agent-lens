import type {
  ObservationRepository,
  SourceRecordRepository,
} from '@agent-lens/core'
import type { SqliteExecutor } from './executor'

interface DerivedRelationshipRow {
  from_logical_session_id: string | null
  to_logical_session_id: string | null
  relation_type: string
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
        `).all(sourceRecordId) as Array<{ id: string }>
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
        for (const row of rows) {
          if (hasEvidence.get(row.id)) continue
          detachChildren.run(row.id)
          removed += Number(remove.run(row.id).changes)
        }
        return removed
      })
    },
  }

  async function removeRelationshipDerivationsForSourceRecord(sourceRecordId: string): Promise<number> {
    return executor.transaction(async () => {
      const candidates = executor.db.prepare(`
        SELECT DISTINCT
          from_ss.logical_session_id AS from_logical_session_id,
          to_ss.logical_session_id AS to_logical_session_id,
          COALESCE(c.relation_type, 'related') AS relation_type
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
      `).all(sourceRecordId) as DerivedRelationshipRow[]

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
        const fromSessionId = candidate.from_logical_session_id
        const toSessionId = candidate.to_logical_session_id
        if (!fromSessionId || !toSessionId) continue
        if (hasRemainingSupport.get(fromSessionId, toSessionId, candidate.relation_type)) continue
        removedRelationships += Number(
          removeRelationship.run(fromSessionId, toSessionId, candidate.relation_type).changes,
        )
      }
      return deletedCandidates + removedRelationships
    })
  }

  const replayAwareSourceRecords: SourceRecordRepository = {
    ...sourceRecords,
    async put(record) {
      const existing = await sourceRecords.get(record.id)
      if (existing && existing.parserVersion !== record.parserVersion) {
        await replayAwareObservations.removeDerivationsForSourceRecord?.(record.id)
        await removeRelationshipDerivationsForSourceRecord(record.id)
      }
      await sourceRecords.put(record)
    },
  }

  return {
    sourceRecords: replayAwareSourceRecords,
    observations: replayAwareObservations,
  }
}
