import type { SqliteExecutor } from './executor'
import { isSlimDatabase } from './slim-schema'

export interface SlimNativeSessionIdentity {
  sourceId: string
  installationId: string
  nativeSessionId: string
}

export interface SlimNativeSessionContext extends SlimNativeSessionIdentity {
  runtimeProfileId?: string
  projectId?: string
  workspaceId?: string
  titleOverride?: string
  titleKind?: 'explicit' | 'generated'
  updatedAt: string
}

export type SlimNativeSessionContextPatch = SlimNativeSessionIdentity &
  Partial<Omit<SlimNativeSessionContext, keyof SlimNativeSessionIdentity | 'updatedAt'>> & {
    updatedAt?: string
  }

const optional = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

function decode(value: Record<string, unknown>): SlimNativeSessionContext {
  return {
    sourceId: String(value.source_id),
    installationId: String(value.installation_id),
    nativeSessionId: String(value.native_session_id),
    ...(optional(value.runtime_profile_id) ? { runtimeProfileId: optional(value.runtime_profile_id)! } : {}),
    ...(optional(value.project_id) ? { projectId: optional(value.project_id)! } : {}),
    ...(optional(value.workspace_id) ? { workspaceId: optional(value.workspace_id)! } : {}),
    ...(optional(value.title_override) ? { titleOverride: optional(value.title_override)! } : {}),
    ...(value.title_kind === 'explicit' || value.title_kind === 'generated'
      ? { titleKind: value.title_kind } : {}),
    updatedAt: String(value.updated_at),
  }
}

function checkIdentity(input: SlimNativeSessionIdentity): void {
  for (const field of ['sourceId', 'installationId', 'nativeSessionId'] as const) {
    if (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > 512) {
      throw new TypeError('Invalid native session context identity: ' + field)
    }
  }
}

/** Non-event metadata for project/workspace attribution and saved titles.
 * This store is slim-only: never synthesizes logical_sessions, SourceRecords
 * or Evidence just to associate a Source-native conversation with a project.
 */
export class SqliteSlimNativeSessionContexts {
  constructor(private readonly executor: SqliteExecutor) {
    if (!isSlimDatabase(executor.db)) {
      throw new Error('Native session contexts require slim SQLite')
    }
  }

  get(input: SlimNativeSessionIdentity): Promise<SlimNativeSessionContext | null> {
    checkIdentity(input)
    return this.executor.run(() => {
      const result = this.executor.db.prepare(`
        SELECT * FROM native_session_context
        WHERE source_id=? AND installation_id=? AND native_session_id=?
      `).get(input.sourceId, input.installationId, input.nativeSessionId) as
        Record<string, unknown> | undefined
      return result ? decode(result) : null
    })
  }

  /** A missing field means retain the prior metadata. Title changes require
   * explicit provenance; no first-user-message fallbacks are generated here.
   */
  upsert(input: SlimNativeSessionContextPatch): Promise<void> {
    checkIdentity(input)
    if (input.titleOverride !== undefined
      && (!input.titleOverride.trim() || input.titleOverride.length > 512
        || (input.titleKind !== 'explicit' && input.titleKind !== 'generated'))) {
      throw new TypeError('A saved native title requires explicit/generated provenance')
    }
    if (input.titleKind !== undefined && input.titleOverride === undefined) {
      throw new TypeError('Title kind requires a saved title in the same update')
    }
    for (const field of ['runtimeProfileId','projectId','workspaceId'] as const) {
      if (input[field] !== undefined && (!input[field]?.trim() || input[field]!.length > 512)) {
        throw new TypeError('Invalid native context metadata: ' + field)
      }
    }
    const updatedAt = input.updatedAt ?? new Date().toISOString()
    if (!Number.isFinite(Date.parse(updatedAt))) throw new TypeError('Invalid context updatedAt')
    return this.executor.run(() => {
      const result=this.executor.db.prepare(`
        INSERT INTO native_session_context(
          source_id,installation_id,native_session_id,runtime_profile_id,
          project_id,workspace_id,title_override,title_kind,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(source_id,installation_id,native_session_id) DO UPDATE SET
          runtime_profile_id=COALESCE(excluded.runtime_profile_id,native_session_context.runtime_profile_id),
          project_id=COALESCE(excluded.project_id,native_session_context.project_id),
          workspace_id=COALESCE(excluded.workspace_id,native_session_context.workspace_id),
          title_override=COALESCE(excluded.title_override,native_session_context.title_override),
          title_kind=COALESCE(excluded.title_kind,native_session_context.title_kind),
          updated_at=excluded.updated_at
        WHERE excluded.runtime_profile_id IS NULL
          OR native_session_context.runtime_profile_id IS NULL
          OR native_session_context.runtime_profile_id=excluded.runtime_profile_id
      `).run(
        input.sourceId,input.installationId,input.nativeSessionId,
        input.runtimeProfileId ?? null,input.projectId ?? null,
        input.workspaceId ?? null,input.titleOverride ?? null,
        input.titleKind ?? null,updatedAt,
      )
      if(result.changes===0) {
        throw new Error('Native session identity collision across runtime profiles')
      }
    })
  }
}
