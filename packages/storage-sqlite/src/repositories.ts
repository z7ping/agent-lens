import type {
  AgentActor,
  AgentInstallation,
  AgentProduct,
  AssetBinding,
  AssetDefinition,
  AssetRepository,
  AssetStateObservation,
  CanonicalObservation,
  CoverageQuery,
  CoverageRepository,
  Evidence,
  EvidenceRepository,
  Host,
  HostRepository,
  InstallationRepository,
  Interaction,
  LogicalSession,
  ObservationCoverage,
  ObservationQuery,
  ObservationRepository,
  Project,
  RepositorySet,
  SessionRelationship,
  SessionRepository,
  SourceRecord,
  SourceRecordRepository,
  SourceSession,
  ToolDefinition,
  ToolRepository,
  Workspace,
} from '@agent-lens/core'
import { SqliteExecutor } from './executor'

const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER

function encodeJson(value: unknown): string {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) {
    throw new TypeError('SQLite persistence requires JSON-serializable values')
  }
  return encoded
}

function decodeJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback
  return JSON.parse(value) as T
}

function mapHost(row: any): Host {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    arch: row.arch,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  }
}

function mapProduct(row: any): AgentProduct {
  return {
    id: row.id,
    name: row.name,
    vendor: row.vendor ?? undefined,
    homepage: row.homepage ?? undefined,
  } as AgentProduct
}

function mapInstallation(row: any): AgentInstallation {
  return {
    id: row.id,
    hostId: row.host_id,
    productId: row.product_id,
    version: row.version ?? undefined,
    executable: row.executable ?? undefined,
    configRoot: row.config_root ?? undefined,
    dataRoot: row.data_root ?? undefined,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  } as AgentInstallation
}

function mapProject(row: any): Project {
  return {
    id: row.id,
    name: row.name ?? undefined,
    repositoryIdentity: row.repository_identity ?? undefined,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  } as Project
}

function mapWorkspace(row: any): Workspace {
  return {
    id: row.id,
    hostId: row.host_id,
    projectId: row.project_id ?? undefined,
    path: row.path,
    repositoryId: row.repository_id ?? undefined,
    worktreeId: row.worktree_id ?? undefined,
  } as Workspace
}

function mapLogicalSession(row: any): LogicalSession {
  return {
    id: row.id,
    installationId: row.installation_id,
    projectId: row.project_id ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    title: row.title ?? undefined,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
  } as LogicalSession
}

function mapSourceSession(row: any): SourceSession {
  return {
    id: row.id,
    sourceId: row.source_id,
    installationId: row.installation_id,
    nativeSessionId: row.native_session_id,
    logicalSessionId: row.logical_session_id ?? undefined,
    nativeParentSessionId: row.native_parent_session_id ?? undefined,
  } as SourceSession
}

function mapRelationship(row: any): SessionRelationship {
  return {
    id: row.id,
    fromSessionId: row.from_session_id,
    toSessionId: row.to_session_id,
    type: row.type,
    evidenceRefs: decodeJson<string[]>(row.evidence_refs_json, []),
    confidence: row.confidence,
  }
}

function mapActor(row: any): AgentActor {
  return {
    id: row.id,
    installationId: row.installation_id,
    logicalSessionId: row.logical_session_id ?? undefined,
    parentActorId: row.parent_actor_id ?? undefined,
    role: row.role,
    nativeActorId: row.native_actor_id ?? undefined,
    evidenceRefs: decodeJson<string[]>(row.evidence_refs_json, []),
  } as AgentActor
}

function mapInteraction(row: any): Interaction {
  return {
    id: row.id,
    logicalSessionId: row.logical_session_id,
    ordinal: Number(row.ordinal),
    trigger: row.trigger,
    startObservationId: row.start_observation_id ?? undefined,
    endObservationId: row.end_observation_id ?? undefined,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
  } as Interaction
}

function mapSourceRecord(row: any): SourceRecord {
  return {
    id: row.id,
    sourceId: row.source_id,
    installationId: row.installation_id,
    sourceSessionNativeId: row.source_session_native_id ?? undefined,
    nativeType: row.native_type,
    nativeId: row.native_id ?? undefined,
    sourceSequence: row.source_sequence == null ? undefined : Number(row.source_sequence),
    occurredAt: row.occurred_at ?? undefined,
    capturedAt: row.captured_at,
    locator: decodeJson(row.locator_json, { kind: 'external' }),
    fingerprint: row.fingerprint ?? undefined,
    payload: decodeJson(row.payload_json, null),
    parserVersion: row.parser_version,
  } as SourceRecord
}

function mapObservation(row: any, evidenceRefs: string[] = []): CanonicalObservation {
  return {
    id: row.id,
    hostId: row.host_id,
    installationId: row.installation_id,
    projectId: row.project_id ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    logicalSessionId: row.logical_session_id,
    sourceSessionId: row.source_session_id,
    interactionId: row.interaction_id ?? undefined,
    actorId: row.actor_id ?? undefined,
    kind: row.kind,
    sourceSequence: row.source_sequence == null ? undefined : Number(row.source_sequence),
    canonicalSequence: row.canonical_sequence == null ? undefined : Number(row.canonical_sequence),
    occurredAt: row.occurred_at ?? undefined,
    capturedAt: row.captured_at,
    payload: decodeJson(row.payload_json, null),
    evidenceRefs,
  } as CanonicalObservation
}

function mapEvidence(row: any): Evidence {
  return {
    id: row.id,
    captureMethod: row.capture_method,
    derivation: row.derivation,
    confidence: row.confidence,
    sourceRecordId: row.source_record_id ?? undefined,
    sourceLocator: row.source_locator_json == null ? undefined : decodeJson(row.source_locator_json, undefined),
    parserVersion: row.parser_version ?? undefined,
    eventTime: row.event_time ?? undefined,
    capturedAt: row.captured_at,
    missingReason: row.missing_reason ?? undefined,
  } as Evidence
}

function mapCoverage(row: any): ObservationCoverage {
  return {
    id: row.id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    capability: row.capability,
    from: row.from_time ?? undefined,
    to: row.to_time ?? undefined,
    status: row.status,
    reason: row.reason ?? undefined,
    evidenceRefs: decodeJson<string[]>(row.evidence_refs_json, []),
  } as ObservationCoverage
}

function mapAssetDefinition(row: any): AssetDefinition {
  return {
    id: row.id,
    type: row.type,
    canonicalName: row.canonical_name,
    displayName: row.display_name ?? undefined,
    upstreamIdentity: row.upstream_identity ?? undefined,
  } as AssetDefinition
}

function mapTool(row: any): ToolDefinition {
  return {
    id: row.id,
    canonicalName: row.canonical_name,
    displayName: row.display_name ?? undefined,
    sourceType: row.source_type,
    assetDefinitionId: row.asset_definition_id ?? undefined,
    installationId: row.installation_id ?? undefined,
    schemaHash: row.schema_hash ?? undefined,
  } as ToolDefinition
}

export function createSqliteRepositories(executor: SqliteExecutor): RepositorySet {
  const { db } = executor

  const hosts: HostRepository = {
    async get(id) {
      return executor.run(() => {
        const row = db.prepare('SELECT * FROM hosts WHERE id = ?').get(id)
        return row ? mapHost(row) : null
      })
    },
    async put(host) {
      await executor.run(() => {
        db.prepare(`
          INSERT INTO hosts(id, name, platform, arch, created_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            platform = excluded.platform,
            arch = excluded.arch,
            last_seen_at = excluded.last_seen_at
        `).run(host.id, host.name, host.platform, host.arch, host.createdAt, host.lastSeenAt)
      })
    },
  }

  const installations: InstallationRepository = {
    async getProduct(id) {
      return executor.run(() => {
        const row = db.prepare('SELECT * FROM agent_products WHERE id = ?').get(id)
        return row ? mapProduct(row) : null
      })
    },
    async putProduct(product) {
      await executor.run(() => {
        db.prepare(`
          INSERT INTO agent_products(id, name, vendor, homepage)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            vendor = excluded.vendor,
            homepage = excluded.homepage
        `).run(product.id, product.name, product.vendor ?? null, product.homepage ?? null)
      })
    },
    async get(id) {
      return executor.run(() => {
        const row = db.prepare('SELECT * FROM agent_installations WHERE id = ?').get(id)
        return row ? mapInstallation(row) : null
      })
    },
    async listByProduct(productId) {
      return executor.run(() => db.prepare(
        'SELECT * FROM agent_installations WHERE product_id = ? ORDER BY id',
      ).all(productId).map(mapInstallation))
    },
    async put(installation) {
      await executor.run(() => {
        db.prepare(`
          INSERT INTO agent_installations(
            id, host_id, product_id, version, executable, config_root, data_root, first_seen_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            host_id = excluded.host_id,
            product_id = excluded.product_id,
            version = excluded.version,
            executable = excluded.executable,
            config_root = excluded.config_root,
            data_root = excluded.data_root,
            last_seen_at = excluded.last_seen_at
        `).run(
          installation.id,
          installation.hostId,
          installation.productId,
          installation.version ?? null,
          installation.executable ?? null,
          installation.configRoot ?? null,
          installation.dataRoot ?? null,
          installation.firstSeenAt,
          installation.lastSeenAt,
        )
      })
    },
  }

  const sessions: SessionRepository = {
    async getProject(id) {
      return executor.run(() => {
        const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id)
        return row ? mapProject(row) : null
      })
    },
    async putProject(project) {
      await executor.run(() => {
        db.prepare(`
          INSERT INTO projects(id, name, repository_identity, created_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            repository_identity = excluded.repository_identity,
            last_seen_at = excluded.last_seen_at
        `).run(
          project.id,
          project.name ?? null,
          project.repositoryIdentity ?? null,
          project.createdAt,
          project.lastSeenAt,
        )
      })
    },
    async getWorkspace(id) {
      return executor.run(() => {
        const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id)
        return row ? mapWorkspace(row) : null
      })
    },
    async putWorkspace(workspace) {
      await executor.run(() => {
        db.prepare(`
          INSERT INTO workspaces(id, host_id, project_id, path, repository_id, worktree_id)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            host_id = excluded.host_id,
            project_id = excluded.project_id,
            path = excluded.path,
            repository_id = excluded.repository_id,
            worktree_id = excluded.worktree_id
        `).run(
          workspace.id,
          workspace.hostId,
          workspace.projectId ?? null,
          workspace.path,
          workspace.repositoryId ?? null,
          workspace.worktreeId ?? null,
        )
      })
    },
    async getLogicalSession(id) {
      return executor.run(() => {
        const row = db.prepare('SELECT * FROM logical_sessions WHERE id = ?').get(id)
        return row ? mapLogicalSession(row) : null
      })
    },
    async putLogicalSession(session) {
      await executor.run(() => {
        db.prepare(`
          INSERT INTO logical_sessions(id, installation_id, project_id, workspace_id, title, started_at, ended_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            installation_id = excluded.installation_id,
            project_id = excluded.project_id,
            workspace_id = excluded.workspace_id,
            title = excluded.title,
            started_at = excluded.started_at,
            ended_at = excluded.ended_at
        `).run(
          session.id,
          session.installationId,
          session.projectId ?? null,
          session.workspaceId ?? null,
          session.title ?? null,
          session.startedAt ?? null,
          session.endedAt ?? null,
        )
      })
    },
    async getSourceSession(id) {
      return executor.run(() => {
        const row = db.prepare('SELECT * FROM source_sessions WHERE id = ?').get(id)
        return row ? mapSourceSession(row) : null
      })
    },
    async findSourceSession(sourceId, installationId, nativeSessionId) {
      return executor.run(() => {
        const row = db.prepare(`
          SELECT * FROM source_sessions
          WHERE source_id = ? AND installation_id = ? AND native_session_id = ?
        `).get(sourceId, installationId, nativeSessionId)
        return row ? mapSourceSession(row) : null
      })
    },
    async putSourceSession(session) {
      await executor.run(() => {
        db.prepare(`
          INSERT INTO source_sessions(
            id, source_id, installation_id, native_session_id, logical_session_id, native_parent_session_id
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            logical_session_id = excluded.logical_session_id,
            native_parent_session_id = excluded.native_parent_session_id
        `).run(
          session.id,
          session.sourceId,
          session.installationId,
          session.nativeSessionId,
          session.logicalSessionId ?? null,
          session.nativeParentSessionId ?? null,
        )
      })
    },
    async putRelationship(relationship) {
      await executor.run(() => {
        db.prepare(`
          INSERT INTO session_relationships(
            id, from_session_id, to_session_id, type, evidence_refs_json, confidence
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            from_session_id = excluded.from_session_id,
            to_session_id = excluded.to_session_id,
            type = excluded.type,
            evidence_refs_json = excluded.evidence_refs_json,
            confidence = excluded.confidence
        `).run(
          relationship.id,
          relationship.fromSessionId,
          relationship.toSessionId,
          relationship.type,
          encodeJson(relationship.evidenceRefs),
          relationship.confidence,
        )
      })
    },
    async listRelationships(logicalSessionId) {
      return executor.run(() => db.prepare(`
        SELECT * FROM session_relationships
        WHERE from_session_id = ? OR to_session_id = ?
        ORDER BY id
      `).all(logicalSessionId, logicalSessionId).map(mapRelationship))
    },
    async getActor(id) {
      return executor.run(() => {
        const row = db.prepare('SELECT * FROM agent_actors WHERE id = ?').get(id)
        return row ? mapActor(row) : null
      })
    },
    async putActor(actor) {
      await executor.run(() => {
        db.prepare(`
          INSERT INTO agent_actors(
            id, installation_id, logical_session_id, parent_actor_id, role, native_actor_id, evidence_refs_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            installation_id = excluded.installation_id,
            logical_session_id = excluded.logical_session_id,
            parent_actor_id = excluded.parent_actor_id,
            role = excluded.role,
            native_actor_id = excluded.native_actor_id,
            evidence_refs_json = excluded.evidence_refs_json
        `).run(
          actor.id,
          actor.installationId,
          actor.logicalSessionId ?? null,
          actor.parentActorId ?? null,
          actor.role,
          actor.nativeActorId ?? null,
          encodeJson(actor.evidenceRefs),
        )
      })
    },
    async getInteraction(id) {
      return executor.run(() => {
        const row = db.prepare('SELECT * FROM interactions WHERE id = ?').get(id)
        return row ? mapInteraction(row) : null
      })
    },
    async putInteraction(interaction) {
      await executor.run(() => {
        db.prepare(`
          INSERT INTO interactions(
            id, logical_session_id, ordinal, trigger, start_observation_id, end_observation_id, started_at, ended_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            ordinal = excluded.ordinal,
            trigger = excluded.trigger,
            start_observation_id = excluded.start_observation_id,
            end_observation_id = excluded.end_observation_id,
            started_at = excluded.started_at,
            ended_at = excluded.ended_at
        `).run(
          interaction.id,
          interaction.logicalSessionId,
          interaction.ordinal,
          interaction.trigger,
          interaction.startObservationId ?? null,
          interaction.endObservationId ?? null,
          interaction.startedAt ?? null,
          interaction.endedAt ?? null,
        )
      })
    },
  }

  const sourceRecords: SourceRecordRepository = {
    async get(id) {
      return executor.run(() => {
        const row = db.prepare('SELECT * FROM source_records WHERE id = ?').get(id)
        return row ? mapSourceRecord(row) : null
      })
    },
    async findByNativeId(sourceId, installationId, nativeId) {
      return executor.run(() => {
        const row = db.prepare(`
          SELECT * FROM source_records
          WHERE source_id = ? AND installation_id = ? AND native_id = ?
          ORDER BY captured_at DESC LIMIT 1
        `).get(sourceId, installationId, nativeId)
        return row ? mapSourceRecord(row) : null
      })
    },
    async put(record) {
      await executor.run(() => {
        db.prepare(`
          INSERT INTO source_records(
            id, source_id, installation_id, source_session_native_id, native_type, native_id,
            source_sequence, occurred_at, captured_at, locator_json, fingerprint, payload_json, parser_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            captured_at = excluded.captured_at,
            locator_json = excluded.locator_json,
            fingerprint = excluded.fingerprint,
            payload_json = excluded.payload_json,
            parser_version = excluded.parser_version
        `).run(
          record.id,
          record.sourceId,
          record.installationId,
          record.sourceSessionNativeId ?? null,
          record.nativeType,
          record.nativeId ?? null,
          record.sourceSequence ?? null,
          record.occurredAt ?? null,
          record.capturedAt,
          encodeJson(record.locator),
          record.fingerprint ?? null,
          encodeJson(record.payload),
          record.parserVersion,
        )
      })
    },
  }

  const observations: ObservationRepository = {
    async get(id) {
      return executor.run(() => {
        const row = db.prepare('SELECT * FROM observations WHERE id = ?').get(id)
        if (!row) return null
        const evidenceRows = db.prepare(
          'SELECT evidence_id FROM observation_evidence WHERE observation_id = ? ORDER BY evidence_id',
        ).all(id) as Array<{ evidence_id: string }>
        return mapObservation(row, evidenceRows.map(item => item.evidence_id))
      })
    },
    async query(query: ObservationQuery) {
      return executor.run(() => {
        const conditions: string[] = []
        const params: unknown[] = []
        if (query.installationId) {
          conditions.push('installation_id = ?')
          params.push(query.installationId)
        }
        if (query.logicalSessionId) {
          conditions.push('logical_session_id = ?')
          params.push(query.logicalSessionId)
        }
        if (query.logicalSessionIds?.length) {
          const placeholders = query.logicalSessionIds.map(() => '?').join(', ')
          conditions.push(`logical_session_id IN (${placeholders})`)
          params.push(...query.logicalSessionIds)
        }
        if (query.kind) {
          conditions.push('kind = ?')
          params.push(query.kind)
        }
        if (query.from) {
          conditions.push('COALESCE(occurred_at, captured_at) >= ?')
          params.push(query.from)
        }
        if (query.to) {
          conditions.push('COALESCE(occurred_at, captured_at) <= ?')
          params.push(query.to)
        }
        if (query.after) {
          const sequence = query.after.sequence ?? MAX_SEQUENCE
          conditions.push(`(
            COALESCE(occurred_at, captured_at) > ?
            OR (
              COALESCE(occurred_at, captured_at) = ?
              AND (
                COALESCE(canonical_sequence, source_sequence, ${MAX_SEQUENCE}) > ?
                OR (
                  COALESCE(canonical_sequence, source_sequence, ${MAX_SEQUENCE}) = ?
                  AND id > ?
                )
              )
            )
          )`)
          params.push(query.after.effectiveAt, query.after.effectiveAt, sequence, sequence, query.after.id)
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
        const limit = Math.max(1, Math.min(query.limit ?? 500, 5000))
        const rows = db.prepare(`
          SELECT * FROM observations ${where}
          ORDER BY
            COALESCE(occurred_at, captured_at) ASC,
            COALESCE(canonical_sequence, source_sequence, ${MAX_SEQUENCE}) ASC,
            id ASC
          LIMIT ?
        `).all(...params, limit)
        if (!rows.length) return []
        const ids = rows.map(row => (row as any).id as string)
        const placeholders = ids.map(() => '?').join(', ')
        const evidenceRows = db.prepare(`
          SELECT observation_id, evidence_id
          FROM observation_evidence
          WHERE observation_id IN (${placeholders})
          ORDER BY observation_id, evidence_id
        `).all(...ids) as Array<{ observation_id: string; evidence_id: string }>
        const evidenceByObservation = new Map<string, string[]>()
        for (const row of evidenceRows) {
          const values = evidenceByObservation.get(row.observation_id) ?? []
          values.push(row.evidence_id)
          evidenceByObservation.set(row.observation_id, values)
        }
        return rows.map(row => mapObservation(row, evidenceByObservation.get((row as any).id) ?? []))
      })
    },
    async put(observation) {
      await executor.transaction(async () => {
        db.prepare(`
          INSERT INTO observations(
            id, host_id, installation_id, project_id, workspace_id, logical_session_id, source_session_id,
            interaction_id, actor_id, kind, source_sequence, canonical_sequence, occurred_at, captured_at, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            project_id = excluded.project_id,
            workspace_id = excluded.workspace_id,
            interaction_id = excluded.interaction_id,
            actor_id = excluded.actor_id,
            kind = excluded.kind,
            source_sequence = excluded.source_sequence,
            canonical_sequence = excluded.canonical_sequence,
            occurred_at = excluded.occurred_at,
            captured_at = excluded.captured_at,
            payload_json = excluded.payload_json
        `).run(
          observation.id,
          observation.hostId,
          observation.installationId,
          observation.projectId ?? null,
          observation.workspaceId ?? null,
          observation.logicalSessionId,
          observation.sourceSessionId,
          observation.interactionId ?? null,
          observation.actorId ?? null,
          observation.kind,
          observation.sourceSequence ?? null,
          observation.canonicalSequence ?? null,
          observation.occurredAt ?? null,
          observation.capturedAt,
          encodeJson(observation.payload),
        )
        db.prepare('DELETE FROM observation_evidence WHERE observation_id = ?').run(observation.id)
        const link = db.prepare(
          'INSERT INTO observation_evidence(observation_id, evidence_id) VALUES (?, ?)',
        )
        for (const evidenceId of observation.evidenceRefs) {
          link.run(observation.id, evidenceId)
        }
      })
    },
  }

  const evidence: EvidenceRepository = {
    async get(id) {
      return executor.run(() => {
        const row = db.prepare('SELECT * FROM evidence WHERE id = ?').get(id)
        return row ? mapEvidence(row) : null
      })
    },
    async getMany(ids) {
      if (!ids.length) return []
      return executor.run(() => {
        const uniqueIds = [...new Set(ids)]
        const placeholders = uniqueIds.map(() => '?').join(', ')
        return db.prepare(`SELECT * FROM evidence WHERE id IN (${placeholders}) ORDER BY id`)
          .all(...uniqueIds)
          .map(mapEvidence)
      })
    },
    async put(item) {
      await executor.run(() => {
        db.prepare(`
          INSERT INTO evidence(
            id, capture_method, derivation, confidence, source_record_id, source_locator_json,
            parser_version, event_time, captured_at, missing_reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            confidence = excluded.confidence,
            source_record_id = excluded.source_record_id,
            source_locator_json = excluded.source_locator_json,
            parser_version = excluded.parser_version,
            event_time = excluded.event_time,
            captured_at = excluded.captured_at,
            missing_reason = excluded.missing_reason
        `).run(
          item.id,
          item.captureMethod,
          item.derivation,
          item.confidence,
          item.sourceRecordId ?? null,
          item.sourceLocator ? encodeJson(item.sourceLocator) : null,
          item.parserVersion ?? null,
          item.eventTime ?? null,
          item.capturedAt,
          item.missingReason ?? null,
        )
      })
    },
    async listForObservation(observationId) {
      return executor.run(() => db.prepare(`
        SELECT e.* FROM evidence e
        JOIN observation_evidence oe ON oe.evidence_id = e.id
        WHERE oe.observation_id = ?
        ORDER BY e.id
      `).all(observationId).map(mapEvidence))
    },
  }

  const coverage: CoverageRepository = {
    async put(item) {
      await executor.run(() => {
        db.prepare(`
          INSERT INTO coverage(
            id, subject_type, subject_id, capability, from_time, to_time, status, reason, evidence_refs_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            subject_type = excluded.subject_type,
            subject_id = excluded.subject_id,
            capability = excluded.capability,
            from_time = excluded.from_time,
            to_time = excluded.to_time,
            status = excluded.status,
            reason = excluded.reason,
            evidence_refs_json = excluded.evidence_refs_json
        `).run(
          item.id,
          item.subjectType,
          item.subjectId,
          item.capability,
          item.from ?? null,
          item.to ?? null,
          item.status,
          item.reason ?? null,
          encodeJson(item.evidenceRefs),
        )
      })
    },
    async query(query: CoverageQuery) {
      return executor.run(() => {
        const conditions: string[] = []
        const params: unknown[] = []
        if (query.subjectType) {
          conditions.push('subject_type = ?')
          params.push(query.subjectType)
        }
        if (query.subjectId) {
          conditions.push('subject_id = ?')
          params.push(query.subjectId)
        }
        if (query.capability) {
          conditions.push('capability = ?')
          params.push(query.capability)
        }
        if (query.from) {
          conditions.push('(to_time IS NULL OR to_time >= ?)')
          params.push(query.from)
        }
        if (query.to) {
          conditions.push('(from_time IS NULL OR from_time <= ?)')
          params.push(query.to)
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
        return db.prepare(`SELECT * FROM coverage ${where} ORDER BY from_time, id`)
          .all(...params)
          .map(mapCoverage)
      })
    },
  }

  const assets: AssetRepository = {
    async getDefinition(id) {
      return executor.run(() => {
        const row = db.prepare('SELECT * FROM asset_definitions WHERE id = ?').get(id)
        return row ? mapAssetDefinition(row) : null
      })
    },
    async putDefinition(definition) {
      await executor.run(() => {
        db.prepare(`
          INSERT INTO asset_definitions(id, type, canonical_name, display_name, upstream_identity)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            type = excluded.type,
            canonical_name = excluded.canonical_name,
            display_name = excluded.display_name,
            upstream_identity = excluded.upstream_identity
        `).run(
          definition.id,
          definition.type,
          definition.canonicalName,
          definition.displayName ?? null,
          definition.upstreamIdentity ?? null,
        )
      })
    },
    async putBinding(binding: AssetBinding) {
      await executor.run(() => {
        db.prepare(`
          INSERT INTO asset_bindings(id, asset_id, installation_id, path, source, version)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            asset_id = excluded.asset_id,
            installation_id = excluded.installation_id,
            path = excluded.path,
            source = excluded.source,
            version = excluded.version
        `).run(
          binding.id,
          binding.assetId,
          binding.installationId,
          binding.path ?? null,
          binding.source ?? null,
          binding.version ?? null,
        )
      })
    },
    async putState(state: AssetStateObservation) {
      await executor.run(() => {
        db.prepare(`
          INSERT INTO asset_state_observations(
            id, asset_binding_id, state, value, observed_at, evidence_refs_json
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            state = excluded.state,
            value = excluded.value,
            observed_at = excluded.observed_at,
            evidence_refs_json = excluded.evidence_refs_json
        `).run(
          state.id,
          state.assetBindingId,
          state.state,
          state.value === 'unknown' ? 'unknown' : state.value ? 'true' : 'false',
          state.observedAt,
          encodeJson(state.evidenceRefs),
        )
      })
    },
  }

  const tools: ToolRepository = {
    async get(id) {
      return executor.run(() => {
        const row = db.prepare('SELECT * FROM tool_definitions WHERE id = ?').get(id)
        return row ? mapTool(row) : null
      })
    },
    async put(definition) {
      await executor.run(() => {
        db.prepare(`
          INSERT INTO tool_definitions(
            id, canonical_name, display_name, source_type, asset_definition_id, installation_id, schema_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            canonical_name = excluded.canonical_name,
            display_name = excluded.display_name,
            source_type = excluded.source_type,
            asset_definition_id = excluded.asset_definition_id,
            installation_id = excluded.installation_id,
            schema_hash = excluded.schema_hash
        `).run(
          definition.id,
          definition.canonicalName,
          definition.displayName ?? null,
          definition.sourceType,
          definition.assetDefinitionId ?? null,
          definition.installationId ?? null,
          definition.schemaHash ?? null,
        )
      })
    },
  }

  return {
    hosts,
    installations,
    sessions,
    sourceRecords,
    observations,
    evidence,
    coverage,
    assets,
    tools,
  }
}
