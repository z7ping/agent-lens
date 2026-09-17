import type { LogicalSession, SessionRepository, SourceSession } from '@agent-lens/core'
import type { SqliteExecutor } from './executor'

function runtimeProfileIdFromRow(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (value == null) return undefined
    throw new TypeError('SQLite runtime profile lookup returned a non-object row')
  }
  const runtimeProfileId = (value as Record<string, unknown>).runtimeProfileId
  if (runtimeProfileId == null) return undefined
  if (typeof runtimeProfileId !== 'string') {
    throw new TypeError('SQLite runtime profile lookup field runtimeProfileId must be a string or null')
  }
  return runtimeProfileId
}

/**
 * Completes the runtime_profile_id mapping introduced by schema v4 without
 * duplicating the rest of SessionRepository SQL. Profiled sessions are written
 * with their scope in the same INSERT so the profile-aware unique key is never
 * observed through a temporary NULL value.
 */
export function withSqliteSessionRuntimeProfiles(
  executor: SqliteExecutor,
  base: SessionRepository,
): SessionRepository {
  const readProfileId = (table: 'logical_sessions' | 'source_sessions', id: string): Promise<string | undefined> =>
    executor.run(() => runtimeProfileIdFromRow(
      executor.db.prepare(`SELECT runtime_profile_id AS runtimeProfileId FROM ${table} WHERE id = ?`).get(id),
    ))

  const enrichLogical = async (value: LogicalSession | null): Promise<LogicalSession | null> => {
    if (!value) return null
    const runtimeProfileId = await readProfileId('logical_sessions', value.id)
    return runtimeProfileId ? { ...value, runtimeProfileId } : value
  }

  const enrichSource = async (value: SourceSession | null): Promise<SourceSession | null> => {
    if (!value) return null
    const runtimeProfileId = await readProfileId('source_sessions', value.id)
    return runtimeProfileId ? { ...value, runtimeProfileId } : value
  }

  return {
    ...base,
    async getLogicalSession(id) {
      return enrichLogical(await base.getLogicalSession(id))
    },
    async putLogicalSession(session) {
      if (!session.runtimeProfileId) {
        await base.putLogicalSession(session)
        return
      }
      await executor.run(() => {
        executor.db.prepare(`
          INSERT INTO logical_sessions(
            id, installation_id, runtime_profile_id, project_id, workspace_id, title, started_at, ended_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            installation_id = excluded.installation_id,
            runtime_profile_id = excluded.runtime_profile_id,
            project_id = excluded.project_id,
            workspace_id = excluded.workspace_id,
            title = excluded.title,
            started_at = excluded.started_at,
            ended_at = excluded.ended_at
          WHERE logical_sessions.installation_id IS NOT excluded.installation_id
             OR logical_sessions.runtime_profile_id IS NOT excluded.runtime_profile_id
             OR logical_sessions.project_id IS NOT excluded.project_id
             OR logical_sessions.workspace_id IS NOT excluded.workspace_id
             OR logical_sessions.title IS NOT excluded.title
             OR logical_sessions.started_at IS NOT excluded.started_at
             OR logical_sessions.ended_at IS NOT excluded.ended_at
        `).run(
          session.id,
          session.installationId,
          session.runtimeProfileId,
          session.projectId ?? null,
          session.workspaceId ?? null,
          session.title ?? null,
          session.startedAt ?? null,
          session.endedAt ?? null,
        )
      })
    },
    async getSourceSession(id) {
      return enrichSource(await base.getSourceSession(id))
    },
    async findSourceSession(sourceId, installationId, nativeSessionId) {
      return enrichSource(await base.findSourceSession(sourceId, installationId, nativeSessionId))
    },
    async putSourceSession(session) {
      if (!session.runtimeProfileId) {
        await base.putSourceSession(session)
        return
      }
      await executor.run(() => {
        executor.db.prepare(`
          INSERT INTO source_sessions(
            id, source_id, installation_id, runtime_profile_id,
            native_session_id, logical_session_id, native_parent_session_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            runtime_profile_id = excluded.runtime_profile_id,
            logical_session_id = excluded.logical_session_id,
            native_parent_session_id = excluded.native_parent_session_id
          WHERE source_sessions.runtime_profile_id IS NOT excluded.runtime_profile_id
             OR source_sessions.logical_session_id IS NOT excluded.logical_session_id
             OR source_sessions.native_parent_session_id IS NOT excluded.native_parent_session_id
        `).run(
          session.id,
          session.sourceId,
          session.installationId,
          session.runtimeProfileId,
          session.nativeSessionId,
          session.logicalSessionId ?? null,
          session.nativeParentSessionId ?? null,
        )
      })
    },
  }
}
