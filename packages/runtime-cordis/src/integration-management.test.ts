import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import type { CapturePolicyService } from '@agent-lens/core'
import type { IntegrationPackageState } from '@agent-lens/integration-packages'
import { IntegrationManagementService } from './integration-management'
import { IntegrationPreferenceService } from './integration-preferences'
import type { OfficialToolDiscoverySnapshot } from './tool-discovery'

function packageState(integrationId: string): IntegrationPackageState {
  return {
    integrationId,
    installed: true,
    installedVersion: '1.0.0-alpha.5',
    availableVersion: '1.0.0-alpha.5',
    compatibility: 'compatible',
    integrity: 'verified',
    restartRequired: false,
    entryPath: `/integrations/${integrationId}/index.js`,
  }
}

function capturePolicy(): CapturePolicyService {
  return {
    getSourceConfiguration() {
      return {
        effectiveEnabledSources: ['pi'],
        configuredEnabledSources: ['pi'],
        source: 'file',
        editable: true,
        restartRequired: false,
      }
    },
    async setEnabledSources(enabledSources: readonly string[]) {
      return {
        effectiveEnabledSources: ['pi'],
        configuredEnabledSources: [...enabledSources],
        source: 'file',
        editable: true,
        restartRequired: !enabledSources.includes('pi'),
      }
    },
  } as unknown as CapturePolicyService
}

test('Tool disappearance/recovery never mutates Installed or Enabled and acknowledged tools do not become new again', async () => {
  const path = join(tmpdir(), `agent-lens-integration-management-${process.pid}-recovery.json`)
  const preferences = new IntegrationPreferenceService(path, null)
  let discovery: OfficialToolDiscoverySnapshot = {
    status: 'complete',
    items: [{
      integrationId: 'pi',
      productId: 'pi',
      displayName: 'Pi',
      presence: 'present',
      executable: '/usr/bin/pi',
    }],
    generatedAt: '2026-09-12T00:00:00.000Z',
  }

  const service = new IntegrationManagementService({
    discovery: { snapshot: () => ({ ...discovery, items: discovery.items.map(item => ({ ...item })) }) },
    preferences,
    capturePolicy: capturePolicy(),
    packageState,
    integrationStatus: productId => productId === 'pi'
      ? {
          integrationId: 'pi',
          productId: 'pi',
          enabled: true,
          availability: 'available',
          capabilities: [],
        }
      : null,
  })

  try {
    await preferences.update({ onboardingCompleted: true })

    const first = (await service.query()).items.find(item => item.integrationId === 'pi')
    assert.ok(first)
    assert.equal(first.tool?.presence, 'present')
    assert.equal(first.packageState?.installed, true)
    assert.equal(first.enabled.configured, true)
    assert.equal(first.enabled.effective, true)
    assert.equal(first.isNew, true)

    await preferences.update({ acknowledgedIntegrationIds: ['pi'] })
    discovery = {
      status: 'complete',
      items: [{
        integrationId: 'pi',
        productId: 'pi',
        displayName: 'Pi',
        presence: 'absent',
      }],
      generatedAt: '2026-09-12T00:01:00.000Z',
    }

    const missing = (await service.query()).items.find(item => item.integrationId === 'pi')
    assert.ok(missing)
    assert.equal(missing.tool?.presence, 'absent')
    assert.equal(missing.packageState?.installed, true)
    assert.equal(missing.enabled.configured, true)
    assert.equal(missing.enabled.effective, true)
    assert.equal(missing.isNew, false)

    discovery = {
      status: 'complete',
      items: [{
        integrationId: 'pi',
        productId: 'pi',
        displayName: 'Pi',
        presence: 'present',
        executable: '/usr/bin/pi',
      }],
      generatedAt: '2026-09-12T00:02:00.000Z',
    }

    const restored = (await service.query()).items.find(item => item.integrationId === 'pi')
    assert.ok(restored)
    assert.equal(restored.tool?.presence, 'present')
    assert.equal(restored.packageState?.installed, true)
    assert.equal(restored.enabled.configured, true)
    assert.equal(restored.enabled.effective, true)
    assert.equal(restored.isNew, false)
  } finally {
    await rm(path, { force: true })
  }
})


test('DSH remains visible in Integration Management when only local profile data is discovered and it is not enabled yet', async () => {
  const path = join(tmpdir(), `agent-lens-integration-management-${process.pid}-dsh.json`)
  const preferences = new IntegrationPreferenceService(path, null)
  const discovery: OfficialToolDiscoverySnapshot = {
    status: 'complete',
    items: [{
      integrationId: 'dsh',
      productId: 'dsh',
      displayName: 'DeepSeek Harness',
      presence: 'data-only',
      configRoot: '/srv/dsh',
      dataRoot: '/srv/dsh',
    }],
    generatedAt: '2026-09-17T00:00:00.000Z',
  }
  const service = new IntegrationManagementService({
    discovery: { snapshot: () => discovery },
    preferences,
    capturePolicy: capturePolicy(),
    packageState: integrationId => integrationId === 'dsh'
      ? {
          integrationId: 'dsh',
          installed: false,
          availableVersion: '1.0.0-alpha.5',
          compatibility: 'compatible',
          integrity: 'unknown',
          restartRequired: false,
        }
      : packageState(integrationId),
    integrationStatus: () => null,
  })

  try {
    await preferences.update({ onboardingCompleted: true })
    const dsh = (await service.query()).items.find(item => item.integrationId === 'dsh')
    assert.ok(dsh)
    assert.equal(dsh.tool?.presence, 'data-only')
    assert.equal(dsh.packageState?.installed, false)
    assert.equal(dsh.enabled.configured, false)
    assert.equal(dsh.enabled.effective, false)
    assert.equal(dsh.isNew, true)
  } finally {
    await rm(path, { force: true })
  }
})
