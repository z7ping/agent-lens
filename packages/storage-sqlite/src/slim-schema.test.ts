import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { assertSlimSchema, FORBIDDEN_LEGACY_TABLES, initializeSlimSchema, isSlimDatabase } from './slim-schema'
import { SLIM_SCHEMA_SQL } from './slim-schema-sql'
import { inspectLegacyCutover } from './slim-cutover-preflight'

test('slim v1 is a separate fresh schema without old event or replication tables', async () => {
  const db = new Database(':memory:')
  try {
    await initializeSlimSchema(db)
    assertSlimSchema(db)
    const actual = (db.prepare(`SELECT name FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[])
      .map(row => row.name)
    assert.equal(actual.length, 18)
    for (const forbidden of FORBIDDEN_LEGACY_TABLES) {
      assert.equal(actual.includes(forbidden), false, forbidden)
    }
    assert.deepEqual(db.pragma('foreign_key_check'), [])
    assert.equal((db.prepare('SELECT MAX(version) AS v FROM schema_migrations')
      .get() as {v:number}).v, 1)
    // Data provenance and numeric aggregation are represented without content.
    db.prepare(`INSERT INTO native_session_catalog(
      source_id,installation_id,native_session_id,location_kind,file_path,
      file_identity,file_size,file_mtime_ms,last_activity_at,updated_at
    ) VALUES ('pi','local','s','native','/source/s.jsonl','1:2',400,1,'2026-10-26','2026-10-26')`).run()
    db.prepare(`INSERT INTO native_session_metrics(
      source_id,installation_id,native_session_id,file_identity,file_size,
      file_mtime_ms,parser_version,projection_version,coverage,
      interaction_count,tool_call_count,tool_result_count,tool_error_count,
      error_count,computed_at
    ) VALUES ('pi','local','s','1:2',400,1,'v1','v1','partial',3,1,1,0,0,'2026-10-26')`).run()
    db.prepare(`INSERT INTO native_session_tool_metrics(
      source_id,installation_id,native_session_id,native_tool_name,
      call_count,result_count,error_count,total_duration_ms
    ) VALUES ('pi','local','s','read',1,1,0,12)`).run()
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM native_session_metrics')
      .get() as {c:number}).c, 1)
    assert.deepEqual(db.pragma('foreign_key_check'), [])
  } finally {
    db.close()
  }
})

test('slim initializer refuses existing legacy or already initialized databases', async () => {
  const db = new Database(':memory:')
  try {
    db.exec('CREATE TABLE source_records (id TEXT PRIMARY KEY, payload_json TEXT)')
    await assert.rejects(initializeSlimSchema(db), /refusing existing table/)
    assert.equal((db.prepare(`SELECT COUNT(*) AS c FROM sqlite_master
      WHERE name='native_session_catalog'`).get() as {c:number}).c, 0)
    db.exec('DROP TABLE source_records')
    await initializeSlimSchema(db)
    await assert.rejects(initializeSlimSchema(db), /refusing existing table/)
  } finally {
    db.close()
  }
})

test('read-only preflight counts only metadata, does not claim native recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-lens-slim-'))
  const path = join(dir, 'legacy.sqlite')
  try {
    const source = new Database(path)
    source.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
      INSERT INTO schema_migrations VALUES(38);
      CREATE TABLE source_sessions (
        id TEXT PRIMARY KEY, source_id TEXT, installation_id TEXT, native_session_id TEXT
      );
      CREATE TABLE source_records(id TEXT PRIMARY KEY, payload_json TEXT);
      CREATE TABLE native_session_catalog (
        source_id TEXT, installation_id TEXT, native_session_id TEXT, location_kind TEXT
      );
      INSERT INTO source_sessions VALUES ('one','pi','local','exists');
      INSERT INTO source_sessions VALUES ('two','codex','local','not-indexed');
      INSERT INTO source_records VALUES ('raw','secret prompt should not appear in report');
      INSERT INTO native_session_catalog VALUES ('pi','local','exists','native');
    `)
    source.close()

    const old = new Database(path, { readonly: true, fileMustExist: true })
    try {
      const preflight = inspectLegacyCutover(old)
      assert.equal(preflight.legacySchemaVersion, 38)
      assert.equal(preflight.rowCounts.source_records, 1)
      assert.equal(preflight.rowCounts.source_sessions, 2)
      assert.equal(preflight.nativeLocations, 1)
      assert.equal(preflight.sourceSessionsWithoutCatalog, 1)
      assert.equal(preflight.readyToSwitch, false)
      assert.equal(preflight.verifiedOriginalSourceRecovery, false)
      assert.equal(JSON.stringify(preflight).includes('secret prompt'), false)
    } finally {
      old.close()
    }

    const writable = new Database(path)
    try {
      assert.throws(() => inspectLegacyCutover(writable), /read-only/)
    } finally {
      writable.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('bundled slim schema exactly matches the reviewed standalone SQL file', async () => {
  const diskSql = await readFile(new URL('../slim/001-schema.sql', import.meta.url), 'utf8')
  assert.equal(SLIM_SCHEMA_SQL, diskSql)
  const legacy = new Database(':memory:')
  try {
    legacy.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT);
      INSERT INTO schema_migrations VALUES(1,'initial-1.0-schema','2026-10-26')`)
    assert.equal(isSlimDatabase(legacy), false)
  } finally { legacy.close() }
  const slim = new Database(':memory:')
  try {
    await initializeSlimSchema(slim)
    assert.equal(isSlimDatabase(slim), true)
  } finally { slim.close() }
})
