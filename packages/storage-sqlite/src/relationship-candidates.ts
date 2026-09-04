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

function mapCandidate(row: {
  source_id: string
  installation_id: string
  runtime_profile_id: string | null
  from_native_session_id: string
  to_native_session_id: string
  native_parent_event_id: string | null
  relation_type: SessionRelationshipType | null
  native_relation: string | null
  confidence: SessionRelationshipCandidate['confidence']
  evidence_refs_json: string
}): SessionRelationshipCandidate {
  return {
    sourceId: row.source_id,
    installationId: row.installation_id,
    ...(row.runtime_profile_id ? { runtimeProfileId: row.runtime_profile_id } : {}),
    fromNativeSessionId: row.from_native_session_id,
    toNativeSessionId: row.to_native_session_id,
    ...(row.native_parent_event_id ? { nativeParentEventId: row.native_parent_event_id } : {}),
    ...(row.relation_type ? { type: row.relation_type } : {}),
    ...(row.native_relation ? { nativeRelation: row.native_relation } : {}),
    confidence: row.confidence,
    evidenceRefs: JSON.parse(row.evidence_refs_json || '[]') as string[],
  }
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
      candidate.nativeRelation ?? '',
    ])
    await this.executor.run(() => {
      // 一对原生会话只保留当前 Parser 判定出的主关系，避免 replay 后同时残留 related/subagent/internal-review。
      this.executor.db.prepare(`
        DELETE FROM session_relationship_candidates
        WHERE source_id = ? AND installation_id = ?
          AND COALESCE(runtime_profile_id, '') = ?
          AND from_native_session_id = ? AND to_native_session_id = ?
          AND COALESCE(native_parent_event_id, '') = ?
          AND COALESCE(native_relation, '') = ?
          AND id != ?
      `).run(
        candidate.sourceId,
        candidate.installationId,
        candidate.runtimeProfileId ?? '',
        candidate.fromNativeSessionId,
        candidate.toNativeSessionId,
        candidate.nativeParentEventId ?? '',
        candidate.nativeRelation ?? '',
        id,
      )
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
        DELETE FROM session_relationships
        WHERE from_session_id = ? AND to_session_id = ? AND type != ?
      `).run(relationship.fromSessionId, relationship.toSessionId, type)
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

  async tryPromoteForSession(
    sourceId: string,
    installationId: string,
    nativeSessionId: string,
  ): Promise<number> {
    const candidates = await this.executor.run(() => this.executor.db.prepare(`
      SELECT source_id, installation_id, runtime_profile_id,
             from_native_session_id, to_native_session_id, native_parent_event_id,
             relation_type, native_relation, confidence, evidence_refs_json
      FROM session_relationship_candidates
      WHERE source_id = ? AND installation_id = ?
        AND (from_native_session_id = ? OR to_native_session_id = ?)
      ORDER BY observed_at, id
    `).all(sourceId, installationId, nativeSessionId, nativeSessionId).map(row => mapCandidate(row as any)))

    let promoted = 0
    for (const candidate of candidates) {
      if (await this.tryPromote(candidate)) promoted += 1
    }
    return promoted
  }
}
