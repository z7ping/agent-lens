import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteAssetInventoryReader } from './asset-inventory'
import { SqliteStorageService } from './storage'

test('asset inventory reader returns definitions, bindings and latest-first states', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const firstSeenAt = '2026-08-20T09:00:00.000Z'
    await storage.repositories.hosts.put({
      id: 'host:test',
      name: 'test-host',
      platform: 'win32',
      arch: 'x64',
      createdAt: firstSeenAt,
      lastSeenAt: firstSeenAt,
    })
    await storage.repositories.installations.putProduct({
      id: 'codex',
      name: 'Codex',
    })
    await storage.repositories.installations.put({
      id: 'installation:codex',
      hostId: 'host:test',
      productId: 'codex',
      firstSeenAt,
      lastSeenAt: firstSeenAt,
    })

    await storage.repositories.assets.putDefinition({
      id: 'asset:skill:review',
      type: 'skill',
      canonicalName: 'review',
      displayName: 'Review Skill',
    })
    await storage.repositories.assets.putBinding({
      id: 'binding:skill:review',
      assetId: 'asset:skill:review',
      installationId: 'installation:codex',
      path: '/tmp/.codex/skills/review',
      source: 'skills-dir',
      scope: 'project',
      scopeRoot: '/tmp/project',
      version: '1.2.0',
    })
    await storage.repositories.assets.putState({
      id: 'state:installed:old',
      assetBindingId: 'binding:skill:review',
      state: 'installed',
      value: false,
      observedAt: '2026-08-20T10:00:00.000Z',
      evidenceRefs: [],
    })
    await storage.repositories.assets.putState({
      id: 'state:installed:new',
      assetBindingId: 'binding:skill:review',
      state: 'installed',
      value: true,
      observedAt: '2026-08-20T11:00:00.000Z',
      evidenceRefs: ['evidence:1'],
    })

    const rows = await storage.assetInventory.listByInstallation('installation:codex')
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.definition.canonicalName, 'review')
    assert.equal(rows[0]?.binding.version, '1.2.0')
    assert.equal(rows[0]?.binding.scope, 'project')
    assert.equal(rows[0]?.binding.scopeRoot, '/tmp/project')
    assert.deepEqual(rows[0]?.states.map(state => [state.id, state.value]), [
      ['state:installed:new', true],
    ])
    const historyCount = storage.db.prepare(`
      SELECT COUNT(*) AS count
      FROM asset_state_observations
      WHERE asset_binding_id = 'binding:skill:review'
    `).get() as { count: number }
    assert.equal(historyCount.count, 2)
    assert.deepEqual(await storage.assetInventory.listByInstallation('installation:other'), [])
  } finally {
    storage.close()
  }
})


test('asset inventory reader accepts model prompt theme and context definitions', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const seenAt = '2026-09-11T00:00:00.000Z'
    await storage.repositories.hosts.put({
      id: 'host:pi-assets',
      name: 'pi-assets',
      platform: process.platform,
      arch: process.arch,
      createdAt: seenAt,
      lastSeenAt: seenAt,
    })
    await storage.repositories.installations.putProduct({ id: 'pi', name: 'Pi' })
    await storage.repositories.installations.put({
      id: 'installation:pi-assets',
      hostId: 'host:pi-assets',
      productId: 'pi',
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
    })

    for (const type of ['model', 'prompt', 'theme', 'context'] as const) {
      await storage.repositories.assets.putDefinition({
        id: `asset:${type}`,
        type,
        canonicalName: `${type}-asset`,
      })
      await storage.repositories.assets.putBinding({
        id: `binding:${type}`,
        assetId: `asset:${type}`,
        installationId: 'installation:pi-assets',
      })
    }

    const rows = await storage.assetInventory.listByInstallation('installation:pi-assets')
    assert.deepEqual(rows.map(row => row.definition.type).sort(), ['context', 'model', 'prompt', 'theme'])
  } finally {
    storage.close()
  }
})


test('asset current state ignores older out-of-order observations while preserving history', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const seenAt = '2026-09-20T00:00:00.000Z'
    await storage.repositories.hosts.put({
      id: 'host:asset-order',
      name: 'asset-order',
      platform: process.platform,
      arch: process.arch,
      createdAt: seenAt,
      lastSeenAt: seenAt,
    })
    await storage.repositories.installations.putProduct({ id: 'pi', name: 'Pi' })
    await storage.repositories.installations.put({
      id: 'installation:asset-order',
      hostId: 'host:asset-order',
      productId: 'pi',
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
    })
    await storage.repositories.assets.putDefinition({
      id: 'asset:order',
      type: 'skill',
      canonicalName: 'order',
    })
    await storage.repositories.assets.putBinding({
      id: 'binding:order',
      assetId: 'asset:order',
      installationId: 'installation:asset-order',
    })

    await storage.repositories.assets.putState({
      id: 'state:newer',
      assetBindingId: 'binding:order',
      state: 'installed',
      value: true,
      observedAt: '2026-09-20T02:00:00.000Z',
      evidenceRefs: ['e:newer'],
    })
    await storage.repositories.assets.putState({
      id: 'state:older',
      assetBindingId: 'binding:order',
      state: 'installed',
      value: false,
      observedAt: '2026-09-20T01:00:00.000Z',
      evidenceRefs: ['e:older'],
    })

    const rows = await storage.assetInventory.listByInstallation('installation:asset-order')
    assert.deepEqual(rows[0]?.states.map(state => [state.id, state.value]), [['state:newer', true]])

    const history = storage.db.prepare(`
      SELECT id FROM asset_state_observations
      WHERE asset_binding_id = 'binding:order'
      ORDER BY observed_at DESC, id DESC
    `).all() as Array<{ id: string }>
    assert.deepEqual(history.map(item => item.id), ['state:newer', 'state:older'])
  } finally {
    storage.close()
  }
})

test('asset current state can be rebuilt idempotently from history', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const seenAt = '2026-09-20T00:00:00.000Z'
    await storage.repositories.hosts.put({
      id: 'host:asset-rebuild',
      name: 'asset-rebuild',
      platform: process.platform,
      arch: process.arch,
      createdAt: seenAt,
      lastSeenAt: seenAt,
    })
    await storage.repositories.installations.putProduct({ id: 'pi', name: 'Pi' })
    await storage.repositories.installations.put({
      id: 'installation:asset-rebuild',
      hostId: 'host:asset-rebuild',
      productId: 'pi',
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
    })
    await storage.repositories.assets.putDefinition({
      id: 'asset:rebuild',
      type: 'mcp',
      canonicalName: 'rebuild',
    })
    await storage.repositories.assets.putBinding({
      id: 'binding:rebuild',
      assetId: 'asset:rebuild',
      installationId: 'installation:asset-rebuild',
    })
    await storage.repositories.assets.putState({
      id: 'state:configured',
      assetBindingId: 'binding:rebuild',
      state: 'configured',
      value: true,
      observedAt: '2026-09-20T03:00:00.000Z',
      evidenceRefs: [],
    })

    storage.db.prepare('DELETE FROM asset_current_state').run()
    assert.deepEqual(
      (await storage.assetInventory.listByInstallation('installation:asset-rebuild'))[0]?.states,
      [],
    )

    await storage.assetInventory.rebuildCurrentState?.()
    await storage.assetInventory.rebuildCurrentState?.()
    const rebuilt = await storage.assetInventory.listByInstallation('installation:asset-rebuild')
    assert.deepEqual(
      rebuilt[0]?.states.map(state => [state.id, state.state, state.value]),
      [['state:configured', 'configured', true]],
    )
  } finally {
    storage.close()
  }
})

test('migration 30 backfills only the latest state per binding and state', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const seenAt = '2026-09-20T00:00:00.000Z'
    await storage.repositories.hosts.put({
      id: 'host:asset-migration',
      name: 'asset-migration',
      platform: process.platform,
      arch: process.arch,
      createdAt: seenAt,
      lastSeenAt: seenAt,
    })
    await storage.repositories.installations.putProduct({ id: 'pi', name: 'Pi' })
    await storage.repositories.installations.put({
      id: 'installation:asset-migration',
      hostId: 'host:asset-migration',
      productId: 'pi',
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
    })
    await storage.repositories.assets.putDefinition({
      id: 'asset:migration',
      type: 'plugin',
      canonicalName: 'migration',
    })
    await storage.repositories.assets.putBinding({
      id: 'binding:migration',
      assetId: 'asset:migration',
      installationId: 'installation:asset-migration',
    })
    await storage.repositories.assets.putState({
      id: 'state:migration:old',
      assetBindingId: 'binding:migration',
      state: 'enabled',
      value: false,
      observedAt: '2026-09-20T01:00:00.000Z',
      evidenceRefs: [],
    })
    await storage.repositories.assets.putState({
      id: 'state:migration:new',
      assetBindingId: 'binding:migration',
      state: 'enabled',
      value: true,
      observedAt: '2026-09-20T02:00:00.000Z',
      evidenceRefs: [],
    })

    storage.db.exec(`
      DROP TABLE asset_current_state;
      DELETE FROM schema_migrations WHERE version = 30;
    `)
    await storage.migrate()

    const rows = await storage.assetInventory.listByInstallation('installation:asset-migration')
    assert.deepEqual(rows[0]?.states.map(state => [state.id, state.value]), [
      ['state:migration:new', true],
    ])
  } finally {
    storage.close()
  }
})

test('asset inventory foreground read uses one bounded current-state query', async () => {
  const prepared: string[] = []
  const executor = {
    db: {
      prepare(sql: string) {
        prepared.push(sql)
        return {
          all(...args: unknown[]) {
            assert.deepEqual(args, ['installation:one-query'])
            return [
              {
                binding_id: 'binding:one-query',
                asset_id: 'asset:one-query',
                installation_id: 'installation:one-query',
                runtime_profile_id: null,
                scope: null,
                scope_root: null,
                path: null,
                source: null,
                version: null,
                asset_type: 'skill',
                canonical_name: 'one-query',
                display_name: null,
                upstream_identity: null,
                id: 'state:one-query',
                asset_binding_id: 'binding:one-query',
                state: 'installed',
                value: 'true',
                observed_at: '2026-09-20T00:00:00.000Z',
                evidence_refs_json: '[]',
              },
            ]
          },
        }
      },
    },
    run<T>(operation: () => T): Promise<T> {
      return Promise.resolve(operation())
    },
  }

  const reader = new SqliteAssetInventoryReader(executor as never)
  const rows = await reader.listByInstallation('installation:one-query')

  assert.equal(prepared.length, 1)
  assert.match(prepared[0]!, /LEFT JOIN asset_current_state/)
  assert.doesNotMatch(prepared[0]!, /asset_state_observations/)
  assert.equal(rows[0]?.states[0]?.id, 'state:one-query')
})
