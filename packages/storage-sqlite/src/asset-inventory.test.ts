import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'

test('asset inventory reader returns definitions, bindings and latest-first states', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
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
    assert.deepEqual(rows[0]?.states.map(state => [state.id, state.value]), [
      ['state:installed:new', true],
      ['state:installed:old', false],
    ])
    assert.deepEqual(await storage.assetInventory.listByInstallation('installation:other'), [])
  } finally {
    storage.close()
  }
})
