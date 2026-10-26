import { readFile } from 'node:fs/promises'
import type Database from 'better-sqlite3'

export const SLIM_SCHEMA_VERSION = 1

/** Only create the replacement schema in an EMPTY staging database.
 * This is deliberately separate from migrateDatabase(v1-v38), so no existing
 * installation can accidentally receive destructive DDL during startup.
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

  // Read the bundled SQL independently of the existing 38-step Legacy migrator.
  const sql = await readFile(new URL('../slim/001-schema.sql', import.meta.url), 'utf8')
  db.pragma('foreign_keys = ON')
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(sql)
    db.prepare(`
      INSERT INTO schema_migrations(version,name,applied_at)
      VALUES (?,?,?)
    `).run(SLIM_SCHEMA_VERSION, 'slim-native-session-v1', new Date().toISOString())
    const violations = db.pragma('foreign_key_check') as unknown[]
    if (violations.length > 0) throw new Error('Slim database has foreign-key violations')
    db.exec('COMMIT')
  } catch (error) {
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
