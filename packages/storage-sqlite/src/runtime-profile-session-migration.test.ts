import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { migrateDatabase } from './migrations'

test('v28 rebuild preserves source session ids and enables profile-aware identity', async () => {
  const db = new Database(':memory:')
  try {
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
        native_profile_id TEXT NOT NULL
      );
      CREATE TABLE logical_sessions (
        id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL REFERENCES agent_installations(id),
        project_id TEXT,
        workspace_id TEXT,
        title TEXT,
        started_at TEXT,
        ended_at TEXT,
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
      CREATE TABLE source_session_reference_audit (
        observation_id TEXT PRIMARY KEY,
        source_session_id TEXT NOT NULL
      );
      CREATE TRIGGER trg_observation_source_session_reference
      AFTER INSERT ON observations BEGIN
        INSERT INTO source_session_reference_audit(observation_id, source_session_id)
        SELECT NEW.id, id FROM source_sessions WHERE id = NEW.source_session_id;
      END;
      CREATE TABLE replication_canonical_changes (
        revision INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        origin_entity_id TEXT NOT NULL
      );
      CREATE TRIGGER trg_rep_change_source_sessions_insert AFTER INSERT ON source_sessions BEGIN
        INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('SourceSession', NEW.id);
      END;
      CREATE TRIGGER trg_rep_change_source_sessions_update AFTER UPDATE ON source_sessions BEGIN
        INSERT INTO replication_canonical_changes(entity_type, origin_entity_id) VALUES ('SourceSession', NEW.id);
      END;

      INSERT INTO agent_installations(id) VALUES ('install-1');
      INSERT INTO runtime_profiles(id, installation_id, native_profile_id)
      VALUES ('profile-a', 'install-1', 'a'), ('profile-b', 'install-1', 'b');
      INSERT INTO logical_sessions(id, installation_id, runtime_profile_id)
      VALUES ('logical-a', 'install-1', 'profile-a'), ('logical-b', 'install-1', 'profile-b');
      INSERT INTO source_sessions(
        id, source_id, installation_id, native_session_id, logical_session_id, runtime_profile_id
      ) VALUES ('source-old', 'dsh', 'install-1', 'same-id', 'logical-a', 'profile-a');
      INSERT INTO observations(id, source_session_id) VALUES ('observation-1', 'source-old');
    `)

    const insertMigration = db.prepare(
      'INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)',
    )
    for (let version = 1; version <= 27; version += 1) {
      insertMigration.run(version, `existing-${version}`, '2026-09-17T00:00:00.000Z')
    }

    assert.equal(await migrateDatabase(db, { throughVersion: 28 }), 28)
    assert.equal(
      (db.prepare("SELECT source_session_id AS id FROM observations WHERE id = 'observation-1'").get() as { id: string }).id,
      'source-old',
    )
    assert.deepEqual(
      db.prepare("SELECT id, runtime_profile_id AS runtimeProfileId FROM source_sessions WHERE id = 'source-old'").get(),
      { id: 'source-old', runtimeProfileId: 'profile-a' },
    )

    db.prepare(`
      INSERT INTO source_sessions(
        id, source_id, installation_id, native_session_id, logical_session_id, runtime_profile_id
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('source-b', 'dsh', 'install-1', 'same-id', 'logical-b', 'profile-b')

    assert.equal(
      (db.prepare(`
        SELECT COUNT(*) AS count FROM source_sessions
        WHERE source_id = 'dsh' AND installation_id = 'install-1' AND native_session_id = 'same-id'
      `).get() as { count: number }).count,
      2,
    )
    assert.throws(() => db.prepare(`
      INSERT INTO source_sessions(
        id, source_id, installation_id, native_session_id, logical_session_id, runtime_profile_id
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('source-a-duplicate', 'dsh', 'install-1', 'same-id', 'logical-a', 'profile-a'))
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    db.prepare('INSERT INTO observations(id, source_session_id) VALUES (?, ?)')
      .run('observation-after-v28', 'source-b')
    assert.deepEqual(
      db.prepare('SELECT observation_id, source_session_id FROM source_session_reference_audit WHERE observation_id = ?')
        .get('observation-after-v28'),
      { observation_id: 'observation-after-v28', source_session_id: 'source-b' },
    )

    const triggers = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'trg_rep_change_source_sessions_%'
      ORDER BY name
    `).all() as Array<{ name: string }>
    assert.deepEqual(triggers.map(row => row.name), [
      'trg_rep_change_source_sessions_insert',
      'trg_rep_change_source_sessions_update',
    ])
    assert.equal(
      (db.prepare(`
        SELECT COUNT(*) AS count FROM replication_canonical_changes
        WHERE entity_type = 'SourceSession' AND origin_entity_id = 'source-b'
      `).get() as { count: number }).count,
      1,
    )
  } finally {
    db.close()
  }
})
