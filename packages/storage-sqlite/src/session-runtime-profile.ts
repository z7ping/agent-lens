import type { LogicalSession, SessionRepository, SourceSession } from '@agent-lens/core'
import type { SqliteExecutor } from './executor'

/**
 * Completes the runtime_profile_id mapping introduced by schema v4 without
 * duplicating the rest of SessionRepository SQL. This applies to every caller,
 * not only replication.
 */
export function withSqliteSessionRuntimeProfiles(
  executor: SqliteExecutor,
  base: SessionRepository,
): SessionRepository {
  const readProfileId = (table: 'logical_sessions' | 'source_sessions', id: string): Promise<string | undefined> =>
    executor.run(() => {
      const row = executor.db.prepare(`SELECT runtime_profile_id AS runtimeProfileId FROM ${table} WHERE id = ?`)
        .get(id) as { runtimeProfileId: string | null } | undefined
      return row?.runtimeProfileId ?? undefined
    })

  const writeProfileId = async (
    table: 'logical_sessions' | 'source_sessions',
    id: string,
    runtimeProfileId: string | undefined,
  ): Promise<void> => {
    if (runtimeProfileId === undefined) return
    await executor.run(() => {
      executor.db.prepare(`UPDATE ${table} SET runtime_profile_id = ? WHERE id = ?`)
        .run(runtimeProfileId, id)
    })
  }

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
      await base.putLogicalSession(session)
      await writeProfileId('logical_sessions', session.id, session.runtimeProfileId)
    },
    async getSourceSession(id) {
      return enrichSource(await base.getSourceSession(id))
    },
    async findSourceSession(sourceId, installationId, nativeSessionId) {
      return enrichSource(await base.findSourceSession(sourceId, installationId, nativeSessionId))
    },
    async putSourceSession(session) {
      await base.putSourceSession(session)
      await writeProfileId('source_sessions', session.id, session.runtimeProfileId)
    },
  }
}
