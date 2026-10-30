import type Database from 'better-sqlite3'
import { SLIM_SCHEMA_SQL, SLIM_SCHEMA_V2_SQL } from './slim-schema-sql'

export const SLIM_SCHEMA_VERSION = 2

/** Only create the replacement schema in an EMPTY staging database.
 * An existing v38 installation cannot receive replacement DDL during startup.
 */
export async function initializeSlimSchema(db: Database.Database): Promise<void> {
  if (db.readonly) throw new Error('Slim schema initialization requires a writable staging database')

  const existing = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
    LIMIT 1
  `).get() as { name: string } | undefined
  if (existing) {
    throw new Error('Slim schema requires an empty staging database; refusing existing table: ' + existing.name)
  }

  // Bundled with the runtime; never resolve source-tree assets at startup.
  db.pragma('foreign_keys = ON')
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(SLIM_SCHEMA_SQL)
    db.prepare(`
      INSERT INTO schema_migrations(version,name,applied_at)
      VALUES (?,?,?)
    `).run(1, 'slim-native-session-v1', new Date().toISOString())
    db.exec(SLIM_SCHEMA_V2_SQL)
    db.prepare(`
      INSERT INTO schema_migrations(version,name,applied_at)
      VALUES (?,?,?)
    `).run(2, 'slim-tool-duration-v2', new Date().toISOString())
    const violations = db.pragma('foreign_key_check') as unknown[]
    if (violations.length > 0) throw new Error('Slim database has foreign-key violations')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Only extend an authenticated slim v1 file. Never alter a Legacy database.
 * A read-only v1 file needs one writable open before duration analytics.
 */
export function upgradeSlimSchema(db: Database.Database): void {
  if (!isSlimDatabase(db)) return
  const row=db.prepare('SELECT MAX(version) AS version FROM schema_migrations')
    .get() as {version:number|null}
  if(row.version===SLIM_SCHEMA_VERSION)return
  if(row.version!==1)throw new Error('Unexpected slim schema version')
  if(db.readonly)throw new Error('Slim v1 tool duration migration requires writable access')
  db.exec('BEGIN IMMEDIATE')
  try{
    db.exec(SLIM_SCHEMA_V2_SQL)
    db.prepare(`INSERT INTO schema_migrations(version,name,applied_at)
      VALUES (?,?,?)`).run(2,'slim-tool-duration-v2',new Date().toISOString())
    db.exec('COMMIT')
  }catch(error){
    db.exec('ROLLBACK')
    throw error
  }
}

/** A new database must never contain tables from the old event store. */
export const FORBIDDEN_LEGACY_TABLES = [
  'source_records',
  'observations',
  'evidence',
  'observation_evidence',
  'interactions',
  'agent_actors',
  'source_sessions',
  'logical_sessions',
  'native_session_write_claims',
  'replication_canonical_changes',
  'replication_frozen_batches',
  'hub_remote_replica_entities',
  'session_summary_projection',
  'tool_usage_fact_projection',
  'asset_state_observations',
] as const

export function assertSlimSchema(db: Database.Database): void {
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]
  const tables = new Set(rows.map(row => row.name))
  if (!tables.has('schema_migrations') || !tables.has('native_session_catalog')
      || !tables.has('native_session_metrics') || !tables.has('native_session_context')
      || !tables.has('asset_bindings') || !tables.has('runtime_profiles')) {
    throw new Error('Slim database is missing required metadata tables')
  }
  for (const table of FORBIDDEN_LEGACY_TABLES) {
    if (tables.has(table)) throw new Error('Slim database retained legacy event table: ' + table)
  }
  const version = db.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1')
    .get() as {version:number} | undefined
  if (version?.version !== SLIM_SCHEMA_VERSION) throw new Error('Unexpected slim schema version')
}

/** Distinguish v1 slim database from the older migration chain (also has version 1). */
export function isSlimDatabase(db: Database.Database): boolean {
  const probe = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'`)
  // Certain readers use a partial SQL test double (SELECT/all only). It
  // cannot represent a migrated database, so use the Legacy query branch.
  if (typeof probe.get !== 'function') return false
  if (!probe.get()) return false
  return Boolean(db.prepare(`SELECT 1 FROM schema_migrations
    WHERE version=1 AND name='slim-native-session-v1'`).get())
}
