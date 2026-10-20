import test from 'node:test'
import assert from 'node:assert/strict'
import type { IntegrationManagementItemDto, LiveProductDto } from '@agent-lens/protocol'
import {
  missingIntegrationLiveReason,
  unregisteredLiveId,
  withUnregisteredIntegrationLives,
} from './live-new-task-candidates'

function integration(
  integrationId = 'third-party',
  productId = 'third-party-product',
): IntegrationManagementItemDto {
  return {
    integrationId, productId, displayName: 'Third-party Agent',
    enabled: {
      configured: true, effective: true, editable: true,
      managedBy: 'file', restartRequired: false,
    },
    packageState: {
      integrationId, installed: true,
      integrity: 'verified', compatibility: 'compatible',
      installedVersion: '1.0.0', availableVersion: '1.0.0',
      restartRequired: false,
    },
    availability: 'partial',
    capabilities: [
      { capability: 'source', availability: 'available' },
      { capability: 'live', availability: 'unavailable',
        authorization: 'required', reasonCode: 'authorization-required' },
    ],
    isNew: false, displayOrder: 20,
  }
}

test('a missing third-party Live appears as unavailable without invented capabilities', () => {
  const item = integration()
  const products = withUnregisteredIntegrationLives([], [item], () => 'needs authorization')
  assert.equal(products.length, 1)
  assert.equal(products[0]?.liveId, unregisteredLiveId(item))
  assert.equal(products[0]?.productId, item.productId)
  assert.equal(products[0]?.availability.available, false)
  assert.equal(products[0]?.availability.reason, 'needs authorization')
  assert.deepEqual(products[0]?.capabilities, [])
  assert.equal(products[0]?.startCapabilities.workspace, 'unsupported')
  assert.equal(missingIntegrationLiveReason(item), 'needs-authorization')
})

test('registered Live descriptor remains authoritative even when liveId differs from productId', () => {
  const item = integration()
  const live: LiveProductDto = {
    liveId: 'runtime-plugin-id', productId: item.productId, displayName: 'Runtime',
    availability: { available: true }, capabilities: ['create'],
    inputCapabilities: {
      text: 'native', largeText: 'unsupported', image: 'unsupported',
      file: 'unsupported', multiline: 'native',
    },
    startCapabilities: { workspace: 'optional', title: 'optional' },
    runtimes: [],
  }
  assert.deepEqual(withUnregisteredIntegrationLives([live], [item], () => 'stale'), [live])
})

test('all missing Live-enabled integrations appear without provider-specific UI logic', () => {
  const sourceOnly = integration('source-only', 'source-only-product')
  sourceOnly.capabilities = [{ capability: 'source', availability: 'available' }]
  const missing = [integration(), integration('second', 'second-product'), sourceOnly]
  assert.deepEqual(
    withUnregisteredIntegrationLives([], missing, () => 'unavailable').map(item => item.productId),
    ['third-party-product', 'second-product'],
  )
  assert.equal(withUnregisteredIntegrationLives([], [], () => 'error').length, 0)
})

test('missing package and restart status use Integration lifecycle semantics', () => {
  const unplugged = integration()
  unplugged.packageState = { ...unplugged.packageState!, installed: false }
  assert.equal(missingIntegrationLiveReason(unplugged), 'not-installed')
  const restarted = integration()
  restarted.capabilities = [
    { capability: 'live', availability: 'unavailable',
      authorization: 'granted', reasonCode: 'authorization-restart-required' },
  ]
  assert.equal(missingIntegrationLiveReason(restarted), 'needs-restart')
})
