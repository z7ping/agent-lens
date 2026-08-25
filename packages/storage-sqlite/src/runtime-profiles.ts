import { createHash } from 'node:crypto'
import type { RuntimeProfile, RuntimeProfileIdentityHint } from '@agent-lens/core'
import { SqliteExecutor } from './executor'

function stableId(parts: unknown[]): string {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)
  return `runtime-profile-${digest}`
}

export class SqliteRuntimeProfileRepository {
  constructor(private readonly executor: SqliteExecutor) {}

  async resolve(hint: RuntimeProfileIdentityHint): Promise<RuntimeProfile> {
    return this.executor.run(() => {
      const existing = this.executor.db.prepare(`
        SELECT * FROM runtime_profiles
        WHERE installation_id = ? AND native_profile_id = ?
      `).get(hint.installationId, hint.nativeProfileId) as any
      const now = new Date().toISOString()
      const profile: RuntimeProfile = {
        id: existing?.id ?? stableId([hint.installationId, hint.nativeProfileId]),
        installationId: hint.installationId,
        nativeProfileId: hint.nativeProfileId,
        ...(hint.name ?? existing?.name ? { name: hint.name ?? existing.name } : {}),
        ...(hint.configRoot ?? existing?.config_root ? { configRoot: hint.configRoot ?? existing.config_root } : {}),
        ...(hint.dataRoot ?? existing?.data_root ? { dataRoot: hint.dataRoot ?? existing.data_root } : {}),
        firstSeenAt: existing?.first_seen_at ?? now,
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
      const row = this.executor.db.prepare('SELECT * FROM runtime_profiles WHERE id = ?').get(id) as any
      if (!row) return null
      return {
        id: row.id,
        installationId: row.installation_id,
        nativeProfileId: row.native_profile_id,
        ...(row.name ? { name: row.name } : {}),
        ...(row.config_root ? { configRoot: row.config_root } : {}),
        ...(row.data_root ? { dataRoot: row.data_root } : {}),
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
      }
    })
  }

  async attachSession(
    sourceId: string,
    installationId: string,
    nativeSessionId: string,
    runtimeProfileId: string,
  ): Promise<void> {
    await this.executor.run(() => {
      this.executor.db.prepare(`
        UPDATE source_sessions
        SET runtime_profile_id = ?
        WHERE source_id = ? AND installation_id = ? AND native_session_id = ?
      `).run(runtimeProfileId, sourceId, installationId, nativeSessionId)
      this.executor.db.prepare(`
        UPDATE logical_sessions
        SET runtime_profile_id = ?
        WHERE id IN (
          SELECT logical_session_id FROM source_sessions
          WHERE source_id = ? AND installation_id = ? AND native_session_id = ?
        )
      `).run(runtimeProfileId, sourceId, installationId, nativeSessionId)
    })
  }

  async attachAssetBinding(assetBindingId: string, runtimeProfileId: string): Promise<void> {
    await this.executor.run(() => {
      this.executor.db.prepare(`
        UPDATE asset_bindings
        SET runtime_profile_id = ?
        WHERE id = ?
      `).run(runtimeProfileId, assetBindingId)
    })
  }
}
