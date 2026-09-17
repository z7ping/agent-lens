import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import test from 'node:test'
import { migrateDatabase } from './migrations'

function seedV27Schema(db: Database.Database): void {
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE agent_installations (id TEXT PRIMARY KEY);
    CREATE TABLE runtime_profiles (
      id TEXT PRIMARY KEY,
      installation_id TEXT NOT NULL REFERENCES agent_installations(id),
      native_profile_id TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      UNIQUE(installation_id, native_profile_id)
    );
    CREATE TABLE logical_sessions (
      id TEXT PRIMARY KEY,
      installation_id TEXT NOT NULL REFERENCES agent_installations(id),
      runtime_profile_id TEXT REFERENCES runtime_profiles(id)
    );
    CREATE TABLE source_sessions (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      installation_id TEXT NOT NULL REFERENCES agent_installations(id),
      native_session_id TEXT NOT NULL,
      logical_session_id TEXT REFERENCES logical_sessions(id),
      native_parent_session_id TEXT,
      runtime_profile_id TEXT REFERENCES runtime_profiles(id),
      UNIQUE(source_id, installation_id, native_session_id)
    );
    CREATE INDEX idx_source_sessions_logical ON source_sessions(logical_session_id);
    CREATE INDEX idx_source_sessions_runtime_profile ON source_sessions(runtime_profile_id);
    CREATE TABLE observations (
      id TEXT PRIMARY KEY,
      source_session_id TEXT NOT NULL REFERENCES source_sessions(id)
    );
    CREATE TABLE replication_canonical_changes (
      revision INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      origin_entity_id TEXT NOT NULL,
      changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TRIGGER trg_rep_change_source_sessions_insert AFTER INSERT ON source_sessions BEGIN
      INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('SourceSession', NEW.id);
    END;
    CREATE TRIGGER trg_rep_change_source_sessions_update AFTER UPDATE ON source_sessions BEGIN
      INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('SourceSession', NEW.id);
    END;
  `)

  const insertMigration = db.prepare(
    'INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)',
  )
  for (let version = 1; version <= 27; version += 1) {
    insertMigration.run(version, `v${version}`, '2026-09-17T00:00:00.000Z')
  }

  db.exec(`
    INSERT INTO agent_installations(id) VALUES ('install-1');
    INSERT INTO logical_sessions(id, installation_id) VALUES ('logical-legacy', 'install-1');
    INSERT INTO source_sessions(
      id, source_id, installation_id, native_session_id, logical_session_id
    ) VALUES (
      'source-legacy', 'dsh', 'install-1', 'same-native', 'logical-legacy'
    );
    INSERT INTO observations(id, source_session_id) VALUES ('observation-legacy', 'source-legacy');
  `)
}

test('v28 migrates source session identity to RuntimeProfile scope without breaking legacy references', async () => {
  const db = new Database(':memory:')
  try {
    seedV27Schema(db)
    assert.equal(await migrateDatabase(db), 28)

    const foreignKeyErrors = db.prepare('PRAGMA foreign_key_check').all()
    assert.deepEqual(foreignKeyErrors, [])
    assert.equal(
      (db.prepare('SELECT source_session_id AS sourceSessionId FROM observations WHERE id = ?')
        .get('observation-legacy') as { sourceSessionId: string }).sourceSessionId,
      'source-legacy',
    )

    const indexes = db.prepare("PRAGMA index_list('source_sessions')").all() as Array<{ name: string }>
    const names = new Set(indexes.map(item => item.name))
    assert.ok(names.has('idx_source_sessions_identity_legacy'))
    assert.ok(names.has('idx_source_sessions_identity_profile'))

    assert.throws(() => db.prepare(`
      INSERT INTO source_sessions(id, source_id, installation_id, native_session_id)
      VALUES ('legacy-duplicate', 'dsh', 'install-1', 'same-native')
    `).run())

    db.exec(`
      INSERT INTO runtime_profiles(id, installation_id, native_profile_id, first_seen_at, last_seen_at)
      VALUES
        ('profile-a', 'install-1', 'a', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z'),
        ('profile-b', 'install-1', 'b', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z');
      INSERT INTO source_sessions(id, source_id, installation_id, runtime_profile_id, native_session_id)
      VALUES
        ('source-a', 'dsh', 'install-1', 'profile-a', 'same-profile-native'),
        ('source-b', 'dsh', 'install-1', 'profile-b', 'same-profile-native');
    `)
    assert.throws(() => db.prepare(`
      INSERT INTO source_sessions(id, source_id, installation_id, runtime_profile_id, native_session_id)
      VALUES ('source-a-duplicate', 'dsh', 'install-1', 'profile-a', 'same-profile-native')
    `).run())

    const journal = db.prepare(`
      SELECT origin_entity_id AS originEntityId
      FROM replication_canonical_changes
      WHERE entity_type = 'SourceSession'
      ORDER BY revision
    `).all() as Array<{ originEntityId: string }>
    assert.ok(journal.some(item => item.originEntityId === 'source-a'))
    assert.ok(journal.some(item => item.originEntityId === 'source-b'))
  } finally {
    db.close()
  }
})
