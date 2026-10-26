import { createHash } from 'node:crypto'
import type { RuntimeProfile, RuntimeProfileIdentityHint } from '@agent-lens/core'
import { SqliteExecutor } from './executor'
import { mapRuntimeProfile } from './repository-row-mappers'

type RuntimeProfileRow = Record<string, unknown>

function stableId(parts: unknown[]): string {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)
  return `runtime-profile-${digest}`
}

function rowRecord(value: unknown): RuntimeProfileRow | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as RuntimeProfileRow
    : null
}

export class SqliteRuntimeProfileRepository {
  constructor(private readonly executor: SqliteExecutor) {}

  async resolve(hint: RuntimeProfileIdentityHint): Promise<RuntimeProfile> {
    return this.executor.run(() => {
      const existing = rowRecord(this.executor.db.prepare(`
        SELECT * FROM runtime_profiles
        WHERE installation_id = ? AND native_profile_id = ?
      `).get(hint.installationId, hint.nativeProfileId))
      const now = new Date().toISOString()
      const existingProfile = existing ? mapRuntimeProfile(existing) : null
      const name = hint.name ?? existingProfile?.name
      const configRoot = hint.configRoot ?? existingProfile?.configRoot
      const dataRoot = hint.dataRoot ?? existingProfile?.dataRoot
      const profile: RuntimeProfile = {
        id: existingProfile?.id ?? stableId([hint.installationId, hint.nativeProfileId]),
        installationId: hint.installationId,
        nativeProfileId: hint.nativeProfileId,
        ...(name === undefined ? {} : { name }),
        ...(configRoot === undefined ? {} : { configRoot }),
        ...(dataRoot === undefined ? {} : { dataRoot }),
        firstSeenAt: existingProfile?.firstSeenAt ?? now,
        lastSeenAt: now,
      }
      this.executor.db.prepare(`
        INSERT INTO runtime_profiles(
          id, installation_id, native_profile_id, name, config_root, data_root, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(installation_id, native_profile_id) DO UPDATE SET
          name = excluded.name,
          config_root = excluded.config_root,
          data_root = excluded.data_root,
          last_seen_at = excluded.last_seen_at
      `).run(
        profile.id,
        profile.installationId,
        profile.nativeProfileId,
        profile.name ?? null,
        profile.configRoot ?? null,
        profile.dataRoot ?? null,
        profile.firstSeenAt,
        profile.lastSeenAt,
      )
      return profile
    })
  }

  async get(id: string): Promise<RuntimeProfile | null> {
    return this.executor.run(() => {
      const row = rowRecord(this.executor.db.prepare('SELECT * FROM runtime_profiles WHERE id = ?').get(id))
      return row ? mapRuntimeProfile(row) : null
    })
  }

  /** Bounded, deterministic Profile discovery for the standalone Slim
   * Source coordinator. No SQL session or event data is queried.
   */
  async listByInstallation(installationId:string):Promise<RuntimeProfile[]> {
    if(!installationId||installationId.length>512){
      throw new TypeError('Invalid runtime Profile installation identity')
    }
    return this.executor.run(()=>{
      const rows=this.executor.db.prepare(`
        SELECT * FROM runtime_profiles WHERE installation_id=?
        ORDER BY native_profile_id,id LIMIT 201
      `).all(installationId) as RuntimeProfileRow[]
      if(rows.length>200)throw new Error('Too many runtime Profiles for one installation')
      return rows.map(mapRuntimeProfile)
    })
  }

  async attachSession(
    sourceId: string,
    installationId: string,
    nativeSessionId: string,
    runtimeProfileId: string,
  ): Promise<void> {
    await this.executor.run(() => {
      // One metadata-only association for original native Source sessions.
      this.executor.db.prepare(`
        INSERT INTO native_session_context(
          source_id,installation_id,native_session_id,runtime_profile_id,updated_at
        ) VALUES (?,?,?,?,?)
        ON CONFLICT(source_id,installation_id,native_session_id) DO UPDATE SET
          runtime_profile_id=COALESCE(native_session_context.runtime_profile_id,excluded.runtime_profile_id),
          updated_at=excluded.updated_at
      `).run(sourceId,installationId,nativeSessionId,runtimeProfileId,new Date().toISOString())
    })
  }

  async attachAssetBinding(assetBindingId: string, runtimeProfileId: string): Promise<void> {
    await this.executor.run(() => {
      this.executor.db.prepare(`
        UPDATE asset_bindings
        SET runtime_profile_id = ?
        WHERE id = ?
          AND runtime_profile_id IS NOT ?
      `).run(runtimeProfileId, assetBindingId, runtimeProfileId)
    })
  }
}
