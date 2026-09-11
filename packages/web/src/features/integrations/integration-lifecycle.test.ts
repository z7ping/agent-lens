import assert from 'node:assert/strict'
import test from 'node:test'
import type { TFunction } from 'i18next'
import type {
  AgentOverviewDto,
  IntegrationManagementItemDto,
  IntegrationToolDiscoveryItemDto,
} from '@agent-lens/protocol'
import { integrationLifecycleState } from './integration-lifecycle'

const t = ((key: string) => key) as TFunction

function management(
  patch: Partial<IntegrationManagementItemDto> = {},
): IntegrationManagementItemDto {
  return {
    integrationId: 'pi',
    productId: 'pi',
    displayName: 'Pi',
    packageState: {
      integrationId: 'pi',
      installed: true,
      installedVersion: '1.0.0-alpha.5',
      availableVersion: '1.0.0-alpha.5',
      compatibility: 'compatible',
      integrity: 'verified',
      restartRequired: false,
    },
    enabled: {
      configured: true,
      effective: true,
      editable: true,
      managedBy: 'file',
      restartRequired: false,
    },
    availability: 'available',
    capabilities: [],
    isNew: false,
    displayOrder: 0,
    ...patch,
  }
}

const detectedAgent = {
  supported: true,
  enabled: true,
  detected: true,
} satisfies Pick<AgentOverviewDto, 'supported' | 'enabled' | 'detected'>

function discovery(
  presence: IntegrationToolDiscoveryItemDto['presence'],
): IntegrationToolDiscoveryItemDto {
  return {
    integrationId: 'pi',
    productId: 'pi',
    displayName: 'Pi',
    presence,
  }
}

test('discovered Tool without physical Integration is presented as not added', () => {
  const item = management({
    tool: discovery('present'),
    packageState: {
      integrationId: 'pi',
      installed: false,
      availableVersion: '1.0.0-alpha.5',
      compatibility: 'compatible',
      integrity: 'unknown',
      restartRequired: false,
    },
  })

  assert.deepEqual(
    integrationLifecycleState(undefined, item, item.tool, false, t),
    {
      label: 'status.notAdded',
      title: 'status.notAddedTitle',
      className: 'is-not-added',
    },
  )
})

test('installed but incompatible Integration is presented as abnormal before Enabled state', () => {
  const item = management({
    tool: discovery('present'),
    packageState: {
      integrationId: 'pi',
      installed: true,
      installedVersion: '0.9.0',
      availableVersion: '1.0.0-alpha.5',
      compatibility: 'incompatible',
      integrity: 'verified',
      restartRequired: false,
      reason: 'Plugin API incompatible',
    },
  })

  assert.deepEqual(
    integrationLifecycleState(detectedAgent, item, item.tool, false, t),
    {
      label: 'status.abnormal',
      title: 'Plugin API incompatible',
      className: 'is-error',
    },
  )
})

test('installed but invalid Integration is presented as abnormal before Enabled state', () => {
  const item = management({
    tool: discovery('present'),
    packageState: {
      integrationId: 'pi',
      installed: true,
      installedVersion: '1.0.0-alpha.5',
      availableVersion: '1.0.0-alpha.5',
      compatibility: 'unknown',
      integrity: 'invalid',
      restartRequired: false,
      reason: 'manifest checksum mismatch',
    },
  })

  assert.equal(
    integrationLifecycleState(detectedAgent, item, item.tool, false, t).label,
    'status.abnormal',
  )
})

test('installed Integration that is explicitly disabled is presented as disabled', () => {
  const item = management({
    tool: discovery('present'),
    enabled: {
      configured: false,
      effective: false,
      editable: true,
      managedBy: 'file',
      restartRequired: false,
    },
  })

  assert.equal(
    integrationLifecycleState(detectedAgent, item, item.tool, false, t).label,
    'status.disabled',
  )
})

test('missing local Tool wins over enabled state without mutating Installed or Enabled', () => {
  const item = management({ tool: discovery('absent') })

  assert.equal(
    integrationLifecycleState(undefined, item, item.tool, false, t).label,
    'status.notDetected',
  )
})

test('runtime availability error is presented only after Installed/Detected/Enabled are satisfied', () => {
  const item = management({
    tool: discovery('present'),
    availability: 'error',
  })

  assert.equal(
    integrationLifecycleState(detectedAgent, item, item.tool, false, t).label,
    'status.abnormal',
  )
})

test('missing Package Lifecycle remains unknown instead of pretending uninstalled', () => {
  const item = management({
    tool: discovery('present'),
    packageState: null,
  })

  assert.equal(
    integrationLifecycleState(undefined, item, item.tool, false, t).label,
    'status.managementUnavailable',
  )
})
