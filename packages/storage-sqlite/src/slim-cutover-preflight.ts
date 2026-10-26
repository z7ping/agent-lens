import type Database from 'better-sqlite3'

const AUDITED_TABLES = [
  'hosts', 'agent_products', 'agent_installations', 'runtime_profiles',
  'projects', 'workspaces', 'logical_sessions', 'source_sessions',
  'source_records', 'observations', 'evidence', 'observation_evidence',
  'native_session_catalog', 'native_session_metrics',
  'native_session_tool_metrics', 'source_checkpoints',
  'asset_definitions', 'asset_bindings', 'asset_current_state',
  'asset_state_observations', 'launchable_project_index',
  'launchable_workspace_index', 'native_session_write_claims',
  'replication_canonical_changes', 'replication_frozen_batches',
] as const

export type AuditedTable = typeof AUDITED_TABLES[number]

export interface SlimCutoverPreflight {
  readonly legacySchemaVersion: number | null
  /** Aggregated counts only: no transcript, tool args, checkpoint JSON or paths. */
  readonly rowCounts: Partial<Record<AuditedTable, number>>
  readonly nativeLocations: number
  readonly archiveLocations: number
  /** These rows have no existing Catalog association. NOT proof of data loss. */
  readonly sourceSessionsWithoutCatalog: number | null
  readonly verifiedOriginalSourceRecovery: false
  readonly readyToSwitch: false
  readonly requiredNextChecks: readonly string[]
}

function hasTable(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1
  `).get(name))
}

/** Read-only initial inventory; NEVER modifies, migrates or opens a new DB.
 * A Catalog miss is not the same as a deleted native file: the caller must
 * separately scan the real Sources and report missing/unreachable content.
 */
export function inspectLegacyCutover(db: Database.Database): SlimCutoverPreflight {
  if (!db.readonly) {
    throw new Error('Legacy cutover preflight must use a read-only SQLite connection')
  }
  const rowCounts: Partial<Record<AuditedTable, number>> = {}
  for (const table of AUDITED_TABLES) {
    if (!hasTable(db, table)) continue
    const count = db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number }
    rowCounts[table] = count.count
  }

  const legacySchemaVersion = hasTable(db, 'schema_migrations')
    ? (db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
        version: number | null
      }).version
    : null

  const nativeLocations = hasTable(db, 'native_session_catalog')
    ? (db.prepare(`SELECT COUNT(*) AS count FROM native_session_catalog
        WHERE location_kind='native'`).get() as { count: number }).count
    : 0
  const archiveLocations = hasTable(db, 'native_session_catalog')
    ? (db.prepare(`SELECT COUNT(*) AS count FROM native_session_catalog
        WHERE location_kind='archive'`).get() as { count: number }).count
    : 0

  const sourceSessionsWithoutCatalog = hasTable(db, 'source_sessions')
    ? (hasTable(db, 'native_session_catalog')
        ? (db.prepare(`SELECT COUNT(*) AS count FROM source_sessions AS old
            WHERE NOT EXISTS (
              SELECT 1 FROM native_session_catalog AS native
              WHERE native.source_id=old.source_id
                AND native.installation_id=old.installation_id
                AND native.native_session_id=old.native_session_id
            )`).get() as { count: number }).count
        : rowCounts.source_sessions ?? 0)
    : null

  return {
    legacySchemaVersion,
    rowCounts,
    nativeLocations,
    archiveLocations,
    sourceSessionsWithoutCatalog,
    // A DB-only inspection cannot prove the native content is still readable.
    verifiedOriginalSourceRecovery: false,
    readyToSwitch: false,
    requiredNextChecks: [
      'Make a verified, consistent read-only backup including WAL state',
      'Scan and authorize the real native/archived files for every Source and profile',
      'Report old-only transcripts and user metadata that cannot be recovered',
      'Copy explicitly approved user metadata into a separate slim staging DB',
      'Rebuild Catalog and numerical metrics from native files and compare coverage',
      'Freeze writers, reconcile deltas, validate integrity and atomically cut over',
    ],
  }
}
