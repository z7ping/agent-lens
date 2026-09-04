import type {
  ObservationRepository,
  SourceRecordRepository,
} from '@agent-lens/core'
import type { SqliteExecutor } from './executor'

/**
 * Parser replay 必须替换同一 SourceRecord 的旧 Canonical 派生，而不是简单追加。
 *
 * 这里只删除 Observation -> Evidence 的派生链接以及因此失去全部证据的 Observation：
 * SourceRecord、Evidence、locator 和原始 payload 全部保留。若一个 Observation 同时有
 * 其他 SourceRecord 的证据，它会继续存活。
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

  const replayAwareSourceRecords: SourceRecordRepository = {
    ...sourceRecords,
    async put(record) {
      const existing = await sourceRecords.get(record.id)
      if (existing && existing.parserVersion !== record.parserVersion) {
        await replayAwareObservations.removeDerivationsForSourceRecord?.(record.id)
      }
      await sourceRecords.put(record)
    },
  }

  return {
    sourceRecords: replayAwareSourceRecords,
    observations: replayAwareObservations,
  }
}
