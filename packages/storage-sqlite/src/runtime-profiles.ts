import { createHash } from 'node:crypto'
import type { RuntimeProfile, RuntimeProfileIdentityHint } from '@agent-lens/core'
import { SqliteExecutor } from './executor'

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

function requiredString(row: RuntimeProfileRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new TypeError(`SQLite runtime profile field ${key} must be a string`)
  return value
}

function optionalString(row: RuntimeProfileRow, key: string): string | undefined {
  const value = row[key]
  if (value == null) return undefined
  if (typeof value !== 'string') throw new TypeError(`SQLite runtime profile field ${key} must be a string or null`)
  return value
}

function mapRuntimeProfile(row: RuntimeProfileRow): RuntimeProfile {
  const name = optionalString(row, 'name')
  const configRoot = optionalString(row, 'config_root')
  const dataRoot = optionalString(row, 'data_root')
  return {
    id: requiredString(row, 'id'),
    installationId: requiredString(row, 'installation_id'),
    nativeProfileId: requiredString(row, 'native_profile_id'),
    ...(name === undefined ? {} : { name }),
    ...(configRoot === undefined ? {} : { configRoot }),
    ...(dataRoot === undefined ? {} : { dataRoot }),
    firstSeenAt: requiredString(row, 'first_seen_at'),
    lastSeenAt: requiredString(row, 'last_seen_at'),
  }
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
