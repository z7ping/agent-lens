import { readFile } from 'node:fs/promises'
import type Database from 'better-sqlite3'

interface Migration {
  version: number
  name: string
  fileName: string
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-1.0-schema',
    fileName: '001-initial.sql',
  },
  {
    version: 2,
    name: 'source-checkpoints',
    fileName: '002-source-checkpoints.sql',
  },
]

async function readMigrationSql(fileName: string): Promise<string> {
  const candidates = [
    new URL(`../migrations/${fileName}`, import.meta.url),
    new URL(`./migrations/${fileName}`, import.meta.url),
  ]

  let lastError: unknown
  for (const url of candidates) {
    try {
      return await readFile(url, 'utf8')
    } catch (error) {
      lastError = error
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
    }
  }

  throw lastError ?? new Error(`Migration file not found: ${fileName}`)
}

export async function migrateDatabase(db: Database.Database): Promise<number> {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `)

  const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>
  const applied = new Set(rows.map(row => row.version))

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue

    const sql = await readMigrationSql(migration.fileName)
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(sql)
      db.prepare(
        'INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.name, new Date().toISOString())
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  const latest = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as { version: number }
  return latest.version
}
