import { createHash } from 'node:crypto'
import type {
  SessionRelationship,
  SessionRelationshipCandidate,
  SessionRelationshipType,
} from '@agent-lens/core'
import { SqliteExecutor } from './executor'

function stableId(prefix: string, parts: unknown[]): string {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)
  return `${prefix}-${digest}`
}

export class SqliteSessionRelationshipCandidateRepository {
  constructor(private readonly executor: SqliteExecutor) {}

  async put(candidate: SessionRelationshipCandidate): Promise<void> {
    const id = stableId('session-rel-candidate', [
      candidate.sourceId,
      candidate.installationId,
      candidate.runtimeProfileId ?? '',
      candidate.fromNativeSessionId,
      candidate.toNativeSessionId,
      candidate.nativeParentEventId ?? '',
      candidate.type ?? '',
      candidate.nativeRelation ?? '',
    ])
    await this.executor.run(() => {
      this.executor.db.prepare(`
        INSERT INTO session_relationship_candidates(
          id, source_id, installation_id, runtime_profile_id,
          from_native_session_id, to_native_session_id, native_parent_event_id,
          relation_type, native_relation, confidence, evidence_refs_json, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          relation_type = excluded.relation_type,
          native_relation = excluded.native_relation,
          confidence = excluded.confidence,
          evidence_refs_json = excluded.evidence_refs_json,
          observed_at = excluded.observed_at
      `).run(
        id,
        candidate.sourceId,
        candidate.installationId,
        candidate.runtimeProfileId ?? null,
        candidate.fromNativeSessionId,
        candidate.toNativeSessionId,
        candidate.nativeParentEventId ?? null,
        candidate.type ?? null,
        candidate.nativeRelation ?? null,
        candidate.confidence,
        JSON.stringify(candidate.evidenceRefs ?? []),
        new Date().toISOString(),
      )
    })
  }

  async tryPromote(candidate: SessionRelationshipCandidate): Promise<SessionRelationship | null> {
    return this.executor.run(() => {
      const from = this.executor.db.prepare(`
        SELECT logical_session_id FROM source_sessions
        WHERE source_id = ? AND installation_id = ? AND native_session_id = ?
      `).get(candidate.sourceId, candidate.installationId, candidate.fromNativeSessionId) as { logical_session_id?: string | null } | undefined
      const to = this.executor.db.prepare(`
        SELECT logical_session_id FROM source_sessions
        WHERE source_id = ? AND installation_id = ? AND native_session_id = ?
      `).get(candidate.sourceId, candidate.installationId, candidate.toNativeSessionId) as { logical_session_id?: string | null } | undefined
      if (!from?.logical_session_id || !to?.logical_session_id) return null

      const type: SessionRelationshipType = candidate.type ?? 'related'
      const relationship: SessionRelationship = {
        id: stableId('session-relationship', [from.logical_session_id, to.logical_session_id, type]),
        fromSessionId: from.logical_session_id,
        toSessionId: to.logical_session_id,
        type,
        evidenceRefs: candidate.evidenceRefs ?? [],
        confidence: candidate.confidence,
      }
      this.executor.db.prepare(`
        INSERT INTO session_relationships(
          id, from_session_id, to_session_id, type, evidence_refs_json, confidence
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          evidence_refs_json = excluded.evidence_refs_json,
          confidence = excluded.confidence
      `).run(
        relationship.id,
        relationship.fromSessionId,
        relationship.toSessionId,
        relationship.type,
        JSON.stringify(relationship.evidenceRefs),
        relationship.confidence,
      )
      return relationship
    })
  }
}
