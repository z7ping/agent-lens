import { createHash } from 'node:crypto'
import type {
  Confidence,
  SessionRelationship,
  SessionRelationshipCandidate,
  SessionRelationshipType,
} from '@agent-lens/core'
import { SqliteExecutor } from './executor'

const RELATION_TYPES = ['resume', 'continuation', 'fork', 'branch-task', 'subagent', 'internal-review', 'task-root', 'import-copy', 'related'] as const
const CONFIDENCES = ['exact', 'high', 'medium', 'low', 'unknown'] as const

type CandidateRow = Record<string, unknown>

function stableId(prefix: string, parts: unknown[]): string {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)
  return `${prefix}-${digest}`
}

function rowRecord(value: unknown): CandidateRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('SQLite session relationship candidate query returned a non-object row')
  }
  return value as CandidateRow
}

function requiredString(row: CandidateRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new TypeError(`SQLite session relationship candidate field ${key} must be a string`)
  return value
}

function optionalString(row: CandidateRow, key: string): string | undefined {
  const value = row[key]
  if (value == null) return undefined
  if (typeof value !== 'string') throw new TypeError(`SQLite session relationship candidate field ${key} must be a string or null`)
  return value
}

function enumString<const T extends readonly string[]>(row: CandidateRow, key: string, allowed: T): T[number] {
  const value = requiredString(row, key)
  if (!(allowed as readonly string[]).includes(value)) {
    throw new TypeError(`SQLite session relationship candidate field ${key} has unsupported value: ${value}`)
  }
  return value as T[number]
}

function evidenceRefs(value: unknown): string[] {
  if (typeof value !== 'string') throw new TypeError('SQLite session relationship candidate evidence_refs_json must be a string')
  let parsed: unknown
  try {
    parsed = JSON.parse(value || '[]')
  } catch {
    throw new TypeError('SQLite session relationship candidate evidence_refs_json contains invalid JSON')
  }
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) {
    throw new TypeError('SQLite session relationship candidate evidence_refs_json must contain a JSON string array')
  }
  return parsed
}

function mapCandidate(value: unknown): SessionRelationshipCandidate {
  const row = rowRecord(value)
  const runtimeProfileId = optionalString(row, 'runtime_profile_id')
  const sourceRecordId = optionalString(row, 'source_record_id')
  const nativeParentEventId = optionalString(row, 'native_parent_event_id')
  const relationTypeValue = optionalString(row, 'relation_type')
  const nativeRelation = optionalString(row, 'native_relation')
  let type: SessionRelationshipType | undefined
  if (relationTypeValue !== undefined) {
    if (!(RELATION_TYPES as readonly string[]).includes(relationTypeValue)) {
      throw new TypeError(`SQLite session relationship candidate relation_type has unsupported value: ${relationTypeValue}`)
    }
    type = relationTypeValue as SessionRelationshipType
  }
  const confidence = enumString(row, 'confidence', CONFIDENCES) as Confidence
  return {
    sourceId: requiredString(row, 'source_id'),
    installationId: requiredString(row, 'installation_id'),
    ...(runtimeProfileId === undefined ? {} : { runtimeProfileId }),
    ...(sourceRecordId === undefined ? {} : { sourceRecordId }),
    fromNativeSessionId: requiredString(row, 'from_native_session_id'),
    toNativeSessionId: requiredString(row, 'to_native_session_id'),
    ...(nativeParentEventId === undefined ? {} : { nativeParentEventId }),
    ...(type === undefined ? {} : { type }),
    ...(nativeRelation === undefined ? {} : { nativeRelation }),
    confidence,
    evidenceRefs: evidenceRefs(row.evidence_refs_json),
  }
}

function logicalSessionId(value: unknown): string | undefined {
  if (value == null) return undefined
  const row = rowRecord(value)
  return optionalString(row, 'logical_session_id')
}

export class SqliteSessionRelationshipCandidateRepository {
  constructor(private readonly executor: SqliteExecutor) {}

  async put(candidate: SessionRelationshipCandidate): Promise<void> {
    const id = stableId('session-rel-candidate', [
      candidate.sourceId,
      candidate.installationId,
      candidate.runtimeProfileId ?? '',
      candidate.sourceRecordId ?? '',
      candidate.fromNativeSessionId,
      candidate.toNativeSessionId,
      candidate.nativeParentEventId ?? '',
      candidate.nativeRelation ?? '',
    ])
    await this.executor.run(() => {
      this.executor.db.prepare(`
        DELETE FROM session_relationship_candidates
        WHERE source_id = ? AND installation_id = ?
          AND COALESCE(runtime_profile_id, '') = ?
          AND COALESCE(source_record_id, '') = ?
          AND from_native_session_id = ? AND to_native_session_id = ?
          AND COALESCE(native_parent_event_id, '') = ?
          AND COALESCE(native_relation, '') = ?
          AND id != ?
      `).run(
        candidate.sourceId,
        candidate.installationId,
        candidate.runtimeProfileId ?? '',
        candidate.sourceRecordId ?? '',
        candidate.fromNativeSessionId,
        candidate.toNativeSessionId,
        candidate.nativeParentEventId ?? '',
        candidate.nativeRelation ?? '',
        id,
      )
      this.executor.db.prepare(`
        INSERT INTO session_relationship_candidates(
          id, source_id, installation_id, runtime_profile_id, source_record_id,
          from_native_session_id, to_native_session_id, native_parent_event_id,
          relation_type, native_relation, confidence, evidence_refs_json, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        candidate.sourceRecordId ?? null,
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
      const fromSessionId = logicalSessionId(this.executor.db.prepare(`
        SELECT logical_session_id FROM source_sessions
        WHERE source_id = ? AND installation_id = ? AND native_session_id = ?
      `).get(candidate.sourceId, candidate.installationId, candidate.fromNativeSessionId))
      const toSessionId = logicalSessionId(this.executor.db.prepare(`
        SELECT logical_session_id FROM source_sessions
        WHERE source_id = ? AND installation_id = ? AND native_session_id = ?
      `).get(candidate.sourceId, candidate.installationId, candidate.toNativeSessionId))
      if (!fromSessionId || !toSessionId) return null

      const type: SessionRelationshipType = candidate.type ?? 'related'
      const relationship: SessionRelationship = {
        id: stableId('session-relationship', [fromSessionId, toSessionId, type]),
        fromSessionId,
        toSessionId,
        type,
        evidenceRefs: candidate.evidenceRefs ?? [],
        confidence: candidate.confidence,
      }
      if (type === 'task-root') {
        this.executor.db.prepare(`
          DELETE FROM session_relationships
          WHERE from_session_id = ? AND to_session_id = ? AND type = 'task-root' AND id != ?
        `).run(relationship.fromSessionId, relationship.toSessionId, relationship.id)
      } else {
        this.executor.db.prepare(`
          DELETE FROM session_relationships
          WHERE from_session_id = ? AND to_session_id = ?
            AND type != 'task-root' AND type != ?
        `).run(relationship.fromSessionId, relationship.toSessionId, type)
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

  async tryPromoteForSession(
    sourceId: string,
    installationId: string,
    nativeSessionId: string,
  ): Promise<number> {
    const candidates = await this.executor.run(() => this.executor.db.prepare(`
      SELECT source_id, installation_id, runtime_profile_id, source_record_id,
             from_native_session_id, to_native_session_id, native_parent_event_id,
             relation_type, native_relation, confidence, evidence_refs_json
      FROM session_relationship_candidates
      WHERE source_id = ? AND installation_id = ?
        AND (from_native_session_id = ? OR to_native_session_id = ?)
      ORDER BY observed_at, id
    `).all(sourceId, installationId, nativeSessionId, nativeSessionId).map(mapCandidate))

    let promoted = 0
    for (const candidate of candidates) {
      if (await this.tryPromote(candidate)) promoted += 1
    }
    return promoted
  }
}
