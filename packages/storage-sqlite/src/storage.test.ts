import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'

async function createStorage() {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  return storage
}

test('SQLite storage migrates to schema version 7 and exposes required tables', async () => {
  const storage = await createStorage()
  try {
    const health = await storage.health()
    assert.equal(health.ok, true)
    assert.equal(health.schemaVersion, 7)

    const rows = storage.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ name: string }>
    const tables = new Set(rows.map(row => row.name))

    for (const table of [
      'hosts',
      'agent_products',
      'agent_installations',
      'runtime_profiles',
      'projects',
      'workspaces',
      'logical_sessions',
      'source_sessions',
      'session_relationships',
      'session_relationship_candidates',
      'source_runtime_status',
      'agent_actors',
      'interactions',
      'source_records',
      'source_checkpoints',
      'observations',
      'evidence',
      'coverage',
      'asset_definitions',
      'asset_bindings',
      'asset_state_observations',
      'tool_definitions',
      'session_summary_projection',
    ]) {
      assert.equal(tables.has(table), true, `missing table ${table}`)
    }

    const profileColumns = storage.db.prepare('PRAGMA table_info(runtime_profiles)').all() as Array<{ name: string }>
    assert.equal(profileColumns.some(column => column.name === 'native_profile_id'), true)
    const sessionColumns = storage.db.prepare('PRAGMA table_info(logical_sessions)').all() as Array<{ name: string }>
    assert.equal(sessionColumns.some(column => column.name === 'runtime_profile_id'), true)
    const sourceSessionColumns = storage.db.prepare('PRAGMA table_info(source_sessions)').all() as Array<{ name: string }>
    assert.equal(sourceSessionColumns.some(column => column.name === 'runtime_profile_id'), true)
    const bindingColumns = storage.db.prepare('PRAGMA table_info(asset_bindings)').all() as Array<{ name: string }>
    assert.equal(bindingColumns.some(column => column.name === 'runtime_profile_id'), true)
  } finally {
    storage.close()
  }
})

test('repositories round-trip identity data', async () => {
  const storage = await createStorage()
  try {
    const now = '2026-08-20T07:00:00.000Z'
    await storage.repositories.hosts.put({
      id: 'host-1',
      name: 'local',
      platform: 'win32',
      arch: 'x64',
      createdAt: now,
      lastSeenAt: now,
    })
    await storage.repositories.installations.putProduct({ id: 'codex', name: 'Codex' })
    await storage.repositories.installations.put({
      id: 'install-1', hostId: 'host-1', productId: 'codex', version: '1.2.3', firstSeenAt: now, lastSeenAt: now,
    })
    assert.equal((await storage.repositories.hosts.get('host-1'))?.platform, 'win32')
    assert.equal((await storage.repositories.installations.getProduct('codex'))?.name, 'Codex')
    assert.equal((await storage.repositories.installations.get('install-1'))?.version, '1.2.3')
  } finally { storage.close() }
})

test('runtime profiles resolve stably and attach to canonical sessions', async () => {
  const storage = await createStorage()
  try {
    const now = '2026-08-25T10:00:00.000Z'
    await storage.repositories.hosts.put({ id: 'host-1', name: 'local', platform: 'linux', arch: 'x64', createdAt: now, lastSeenAt: now })
    await storage.repositories.installations.putProduct({ id: 'dsh', name: 'DeepSeek Harness' })
    await storage.repositories.installations.put({ id: 'install-dsh', hostId: 'host-1', productId: 'dsh', firstSeenAt: now, lastSeenAt: now })
    const first = await storage.runtimeProfiles.resolve({ installationId: 'install-dsh', nativeProfileId: 'default', name: 'default', dataRoot: '/home/user/.deepseek/dsh/profiles/default' })
    const second = await storage.runtimeProfiles.resolve({ installationId: 'install-dsh', nativeProfileId: 'default', name: 'default', dataRoot: '/home/user/.deepseek/dsh/profiles/default' })
    assert.equal(second.id, first.id)
    await storage.repositories.sessions.putLogicalSession({ id: 'logical-1', installationId: 'install-dsh' })
    await storage.repositories.sessions.putSourceSession({ id: 'source-1', sourceId: 'dsh', installationId: 'install-dsh', nativeSessionId: 'native-1', logicalSessionId: 'logical-1' })
    await storage.runtimeProfiles.attachSession('dsh', 'install-dsh', 'native-1', first.id)
    const sourceRow = storage.db.prepare('SELECT runtime_profile_id FROM source_sessions WHERE id = ?').get('source-1') as { runtime_profile_id: string | null }
    const logicalRow = storage.db.prepare('SELECT runtime_profile_id FROM logical_sessions WHERE id = ?').get('logical-1') as { runtime_profile_id: string | null }
    assert.equal(sourceRow.runtime_profile_id, first.id)
    assert.equal(logicalRow.runtime_profile_id, first.id)
  } finally { storage.close() }
})

test('source runtime status preserves last error and accumulates failures', async () => {
  const storage = await createStorage()
  try {
    const now = '2026-08-25T10:00:00.000Z'
    await storage.repositories.hosts.put({ id: 'host-1', name: 'local', platform: 'linux', arch: 'x64', createdAt: now, lastSeenAt: now })
    await storage.repositories.installations.putProduct({ id: 'dsh', name: 'DeepSeek Harness' })
    await storage.repositories.installations.put({ id: 'install-dsh', hostId: 'host-1', productId: 'dsh', firstSeenAt: now, lastSeenAt: now })
    const base = { sourceId: 'dsh', installationId: 'install-dsh', stage: 'history' as const, errorCount: 0 }
    await storage.sourceRuntimeStatus.put({ ...base, state: 'running', lastStartedAt: now })
    await storage.sourceRuntimeStatus.put({ ...base, state: 'failed', lastErrorAt: '2026-08-25T10:01:00.000Z', lastErrorSummary: 'first failure' })
    await storage.sourceRuntimeStatus.put({ ...base, state: 'healthy', lastSuccessAt: '2026-08-25T10:02:00.000Z' })
    await storage.sourceRuntimeStatus.put({ ...base, state: 'failed', lastErrorAt: '2026-08-25T10:03:00.000Z', lastErrorSummary: 'second failure' })
    const [status] = await storage.sourceRuntimeStatus.list()
    assert.equal(status?.state, 'failed')
    assert.equal(status?.errorCount, 2)
    assert.equal(status?.lastSuccessAt, '2026-08-25T10:02:00.000Z')
    assert.equal(status?.lastErrorSummary, 'second failure')
    const health = await storage.health()
    const sourceRuntime = (health.details as any)?.sourceRuntime
    assert.equal(sourceRuntime?.failed, 1)
    assert.equal(sourceRuntime?.items?.length, 1)
  } finally { storage.close() }
})

test('source checkpoints persist values independently by scope', async () => {
  const storage = await createStorage()
  try {
    await storage.checkpoints.set('codex:install-a', 'history:file-a', { offset: 128 })
    await storage.checkpoints.set('codex:install-b', 'history:file-a', { offset: 256 })
    assert.deepEqual(await storage.checkpoints.get('codex:install-a', 'history:file-a'), { offset: 128 })
    assert.deepEqual(await storage.checkpoints.get('codex:install-b', 'history:file-a'), { offset: 256 })
    await storage.checkpoints.clear('codex:install-a', 'history:file-a')
    assert.equal(await storage.checkpoints.get('codex:install-a', 'history:file-a'), null)
  } finally { storage.close() }
})

test('async transaction rolls back repository writes atomically', async () => {
  const storage = await createStorage()
  try {
    await assert.rejects(storage.transaction(async tx => {
      await tx.hosts.put({ id: 'rolled-back-host', name: 'rollback', platform: 'linux', arch: 'x64', createdAt: '2026-08-20T07:00:00.000Z', lastSeenAt: '2026-08-20T07:00:00.000Z' })
      throw new Error('force rollback')
    }))
    assert.equal(await storage.repositories.hosts.get('rolled-back-host'), null)
  } finally { storage.close() }
})
