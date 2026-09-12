import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  IntegrationPreferenceService,
  defaultIntegrationDisplayOrder,
  defaultIntegrationPreferences,
  integrationPreferenceBootstrapUpdate,
} from './integration-preferences'

test('Integration preferences keep official default order unconfigured until user migration/reorder', () => {
  const path = join(tmpdir(), `agent-lens-integration-preferences-${process.pid}-default.json`)
  const service = new IntegrationPreferenceService(path, null)
  const snapshot = service.snapshot()
  assert.deepEqual(snapshot.displayOrder, defaultIntegrationDisplayOrder())
  assert.equal(snapshot.displayOrderConfigured, false)
  assert.equal(snapshot.onboarding.completed, false)
})

test('non-order preference writes do not consume the one-time legacy order migration slot', async () => {
  const path = join(tmpdir(), `agent-lens-integration-preferences-${process.pid}-ack.json`)
  const service = new IntegrationPreferenceService(path, null)
  try {
    const updated = await service.update({ acknowledgedIntegrationIds: ['pi'] })
    assert.equal(updated.displayOrderConfigured, false)
    assert.deepEqual(updated.acknowledgedIntegrationIds, ['pi'])
  } finally {
    await rm(path, { force: true })
  }
})

test('display order is normalized to official Integrations and marks global order configured', async () => {
  const path = join(tmpdir(), `agent-lens-integration-preferences-${process.pid}-order.json`)
  const service = new IntegrationPreferenceService(path, null)
  try {
    const updated = await service.update({ displayOrder: ['codex', 'dsh', 'pi', 'codex'] })
    assert.equal(updated.displayOrderConfigured, true)
    assert.deepEqual(updated.displayOrder.slice(0, 2), ['codex', 'pi'])
    assert.equal(updated.displayOrder.includes('dsh'), false)
    assert.equal(new Set(updated.displayOrder).size, updated.displayOrder.length)
  } finally {
    await rm(path, { force: true })
  }
})

test('migrated display order remains authoritative across later non-order preference writes', async () => {
  const path = join(tmpdir(), `agent-lens-integration-preferences-${process.pid}-migrated-order.json`)
  const service = new IntegrationPreferenceService(path, null)
  try {
    const migrated = await service.update({ displayOrder: ['codex', 'pi'] })
    assert.equal(migrated.displayOrderConfigured, true)
    assert.deepEqual(migrated.displayOrder.slice(0, 2), ['codex', 'pi'])

    const later = await service.update({
      onboardingCompleted: true,
      acknowledgedIntegrationIds: ['pi'],
    })
    assert.equal(later.displayOrderConfigured, true)
    assert.deepEqual(later.displayOrder.slice(0, 2), ['codex', 'pi'])
  } finally {
    await rm(path, { force: true })
  }
})

test('acknowledged Integration ids are monotonic and cannot be lost by stale updates', async () => {
  const path = join(tmpdir(), `agent-lens-integration-preferences-${process.pid}-acknowledged.json`)
  const service = new IntegrationPreferenceService(path, null)
  try {
    const first = await service.update({ acknowledgedIntegrationIds: ['pi'] })
    assert.deepEqual(first.acknowledgedIntegrationIds, ['pi'])

    const staleSecond = await service.update({ acknowledgedIntegrationIds: ['codex'] })
    assert.deepEqual(staleSecond.acknowledgedIntegrationIds, ['pi', 'codex'])
  } finally {
    await rm(path, { force: true })
  }
})

test('onboarding completion is monotonic and preserves its first completion timestamp', async () => {
  const path = join(tmpdir(), `agent-lens-integration-preferences-${process.pid}-onboarding.json`)
  const service = new IntegrationPreferenceService(path, null)
  try {
    const first = await service.update({ onboardingCompleted: true })
    const second = await service.update({ onboardingCompleted: true })
    assert.equal(first.onboarding.completed, true)
    assert.equal(second.onboarding.completed, true)
    assert.equal(second.onboarding.completedAt, first.onboarding.completedAt)
  } finally {
    await rm(path, { force: true })
  }
})

test('fresh install persists incomplete onboarding while legacy bootstrap completes exactly once', () => {
  assert.deepEqual(
    integrationPreferenceBootstrapUpdate(null, {
      existingInstallation: false,
      selectedIntegrationIds: [],
    }),
    {},
  )
  assert.deepEqual(
    integrationPreferenceBootstrapUpdate(null, {
      existingInstallation: true,
      selectedIntegrationIds: ['pi', 'dsh', 'codex'],
    }),
    {
      onboardingCompleted: true,
      acknowledgedIntegrationIds: ['pi', 'codex'],
    },
  )
  assert.equal(
    integrationPreferenceBootstrapUpdate(defaultIntegrationPreferences(), {
      existingInstallation: true,
      selectedIntegrationIds: ['pi'],
    }),
    null,
  )
})
