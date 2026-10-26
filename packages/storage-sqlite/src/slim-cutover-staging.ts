import { open, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import { assertSlimSchema, initializeSlimSchema } from './slim-schema'
import { inspectLegacyCutover, type SlimCutoverPreflight } from './slim-cutover-preflight'

export interface SlimStagingPaths {
  /** The old DB is NEVER opened writable by this API. */
  legacyPath: string
  /** A consistent SQLite backup; never overwritten. */
  backupPath: string
  /** A fresh metadata-only DB; never installed automatically. */
  stagingPath: string
}

export interface SlimStagingReport {
  readonly backupPath: string
  readonly stagingPath: string
  readonly source: SlimCutoverPreflight
  readonly copiedRows: Readonly<Record<string, number>>
  readonly readyToSwitch: false
}

/** Explicit data allowlist. DO NOT add event, payload, reflection, or cursor JSON.
 * Metrics and Catalog identities are rebuilt/verified from Source before cutover.
 */
const COPY_TABLES = {
  hosts: ['id', 'name', 'platform', 'arch', 'created_at', 'last_seen_at'],
  agent_products: ['id', 'name', 'vendor', 'homepage'],
  agent_installations: ['id', 'host_id', 'product_id', 'version', 'executable',
    'config_root', 'data_root', 'first_seen_at', 'last_seen_at'],
  runtime_profiles: ['id', 'installation_id', 'native_profile_id', 'name',
    'config_root', 'data_root', 'first_seen_at', 'last_seen_at'],
  projects: ['id', 'name', 'repository_identity', 'created_at', 'last_seen_at'],
  workspaces: ['id', 'host_id', 'project_id', 'path', 'repository_id', 'worktree_id'],
  asset_definitions: ['id', 'type', 'canonical_name', 'display_name', 'upstream_identity'],
  asset_bindings: ['id', 'asset_id', 'installation_id', 'runtime_profile_id',
    'path', 'source', 'version', 'scope', 'scope_root'],
  launchable_project_index: ['project_key', 'project_id', 'project_name',
    'repository_identity', 'last_seen_at'],
  launchable_workspace_index: ['project_key', 'workspace_id', 'workspace_path',
    'last_seen_at', 'validation_status', 'validated_at', 'validated_path'],
  native_session_catalog: ['source_id', 'installation_id', 'native_session_id',
    'location_kind', 'file_path', 'file_identity', 'file_size', 'file_mtime_ms',
    'last_activity_at', 'title', 'updated_at', 'review_session_id'],
} as const

type CopiedTable = keyof typeof COPY_TABLES

function integrityCheck(db: Database.Database): void {
  const result = db.pragma('integrity_check') as Array<{ integrity_check: string }>
  if (result.length !== 1 || result[0]?.integrity_check !== 'ok') {
    throw new Error('SQLite integrity_check failed; refusing cutover staging')
  }
  const fk = db.pragma('foreign_key_check') as unknown[]
  if (fk.length > 0) throw new Error('SQLite foreign_key_check failed; refusing cutover staging')
}

async function reserveNewFile(path: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  await handle.close()
}

function copyWhitelistedRows(
  snapshot: Database.Database,
  stage: Database.Database,
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const [table, columns] of Object.entries(COPY_TABLES) as Array<[CopiedTable, readonly string[]]>) {
    // Constants only: SQL table and field names cannot come from the user or DB.
    const fields = columns.map(name => `"${name}"`).join(',')
    const placeholders = columns.map(() => '?').join(',')
    const reader = snapshot.prepare(`SELECT ${fields} FROM "${table}"`)
    const writer = stage.prepare(`INSERT INTO "${table}" (${fields}) VALUES (${placeholders})`)
    let copied = 0
    for (const row of reader.iterate() as Iterable<Record<string, unknown>>) {
      writer.run(...columns.map(column => row[column]))
      copied += 1
    }
    counts[table] = copied
  }
  return counts
}

function copyCurrentAssetState(snapshot: Database.Database, stage: Database.Database): number {
  // Old observation_id was a FK into historical asset observations. Keep the
  // stable identifier as a state ID only; the observation/evidence history is
  // deliberately NOT present in the replacement database.
  const reader = snapshot.prepare(`
    SELECT asset_binding_id,state,observation_id,value,observed_at
    FROM asset_current_state
  `)
  const writer = stage.prepare(`
    INSERT INTO asset_current_state(asset_binding_id,state,state_id,value,observed_at)
    VALUES (?,?,?,?,?)
  `)
  let count = 0
  for (const item of reader.iterate() as Iterable<{
    asset_binding_id:string
    state:string
    observation_id:string
    value:string
    observed_at:string
  }>) {
    writer.run(item.asset_binding_id,item.state,item.observation_id,item.value,item.observed_at)
    count += 1
  }
  return count
}

function copySessionContexts(snapshot: Database.Database, stage: Database.Database): number {
  const ambiguous = snapshot.prepare(`
    SELECT source_id,installation_id,native_session_id,COUNT(*) AS n
    FROM source_sessions
    GROUP BY source_id,installation_id,native_session_id
    HAVING COUNT(*) > 1 LIMIT 1
  `).get() as { n: number } | undefined
  if (ambiguous) {
    // Older source_sessions can distinguish runtime profiles; the current
    // native Catalog does not. Never collapse distinct sessions silently.
    throw new Error('Ambiguous source-native session identity; migration needs explicit profile reconciliation')
  }

  const reader = snapshot.prepare(`
    SELECT old.source_id, old.installation_id, old.native_session_id,
      old.runtime_profile_id, logical.project_id, logical.workspace_id,
      CASE WHEN logical.title_kind IN ('explicit','generated')
        THEN substr(logical.title,1,512) ELSE NULL END AS title,
      CASE WHEN logical.title_kind IN ('explicit','generated')
        THEN logical.title_kind ELSE NULL END AS title_kind
    FROM source_sessions AS old
    LEFT JOIN logical_sessions AS logical ON logical.id=old.logical_session_id
  `)
  const writer = stage.prepare(`
    INSERT INTO native_session_context(
      source_id,installation_id,native_session_id,runtime_profile_id,
      project_id,workspace_id,title_override,title_kind,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `)
  let count = 0
  const updatedAt = new Date().toISOString()
  for (const row of reader.iterate() as Iterable<{
    source_id: string
    installation_id: string
    native_session_id: string
    runtime_profile_id: string | null
    project_id: string | null
    workspace_id: string | null
    title: string | null
    title_kind: string | null
  }>) {
    writer.run(row.source_id,row.installation_id,row.native_session_id,
      row.runtime_profile_id,row.project_id,row.workspace_id,
      row.title,row.title_kind,updatedAt)
    count += 1
  }
  return count
}

/** Creates *backup* and a separately staged target, never modifies or swaps
 * the running SQLite file. No old message, observation, Evidence or hook body
 * is copied. Requires follow-up Source scan and cutover validation.
 */
export async function stageSlimCutover(paths: SlimStagingPaths): Promise<SlimStagingReport> {
  const legacyPath = resolve(paths.legacyPath)
  const backupPath = resolve(paths.backupPath)
  const stagingPath = resolve(paths.stagingPath)
  if (new Set([legacyPath, backupPath, stagingPath]).size !== 3) {
    throw new Error('Legacy, backup and staging paths must all be distinct')
  }
  // Exclusive creation prevents overwriting an existing DB or backup.
  await stat(legacyPath)
  const live = new Database(legacyPath, { readonly: true, fileMustExist: true })
  try {
    const inspection = inspectLegacyCutover(live)
    if (inspection.legacySchemaVersion !== 38) {
      throw new Error('Unsupported Legacy schema version; expected 38')
    }
    await reserveNewFile(backupPath)
    await live.backup(backupPath)
  } finally {
    live.close()
  }
  const snapshot = new Database(backupPath, { readonly: true, fileMustExist: true })
  try {
    integrityCheck(snapshot)
    const preflight = inspectLegacyCutover(snapshot)
    if (preflight.legacySchemaVersion !== 38) throw new Error('Backup version differs from v38')
    await reserveNewFile(stagingPath)
    const stage = new Database(stagingPath, { fileMustExist: true })
    try {
      stage.pragma('foreign_keys = ON')
      await initializeSlimSchema(stage)
      const copiedRows = stage.transaction(() => {
        const counts = copyWhitelistedRows(snapshot, stage)
        counts.asset_current_state = copyCurrentAssetState(snapshot, stage)
        counts.native_session_context = copySessionContexts(snapshot, stage)
        return counts
      })()
      integrityCheck(stage)
      assertSlimSchema(stage)
      return {
        backupPath, stagingPath, source: preflight, copiedRows,
        readyToSwitch: false,
      }
    } finally {
      stage.close()
    }
  } finally {
    snapshot.close()
  }
}
