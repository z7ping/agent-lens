import test from 'node:test'
import assert from 'node:assert/strict'
import type { IntegrationManagementItemDto, LiveProductDto } from '@agent-lens/protocol'
import { missingCodexLiveReason, withMissingCodexLive } from './live-new-task-candidates'

function codex(): IntegrationManagementItemDto {
  return {
    integrationId: 'codex', productId: 'codex', displayName: 'Codex',
    enabled: {
      configured: true, effective: true, editable: true,
      managedBy: 'file', restartRequired: false,
    },
    packageState: {
      integrationId: 'codex', installed: true,
      integrity: 'verified', compatibility: 'compatible',
      installedVersion: '1.0.0-alpha.7', availableVersion: '1.0.0-alpha.7',
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

test('An authorized-only Codex Live is visible but cannot be started', () => {
  const items = withMissingCodexLive([], codex(), 'needs authorization')
  assert.equal(items.length, 1)
  assert.equal(items[0]?.liveId, 'codex')
  assert.equal(items[0]?.availability.available, false)
  assert.equal(items[0]?.availability.reason, 'needs authorization')
  assert.deepEqual(items[0]?.capabilities, ['create'])
  assert.equal(missingCodexLiveReason(codex()), 'needs-authorization')
})

test('Registered Live adapter remains authoritative and is never duplicated', () => {
  const live: LiveProductDto = {
    ...withMissingCodexLive([], codex(), 'unavailable')[0]!,
    availability: { available: true }, displayName: 'Codex Live',
  }
  assert.deepEqual(withMissingCodexLive([live], codex(), 'stale status'), [live])
})

test('Missing package and restart status explain a missing Codex entry', () => {
  const unplugged = codex()
  unplugged.packageState = { ...unplugged.packageState!, installed: false }
  assert.equal(missingCodexLiveReason(unplugged), 'not-installed')
  const restarted = codex()
  restarted.capabilities = [
    { capability: 'live', availability: 'unavailable',
      authorization: 'granted', reasonCode: 'authorization-restart-required' },
  ]
  assert.equal(missingCodexLiveReason(restarted), 'needs-restart')
})

test('Unknown or unavailable integration management does not invent an adapter', () => {
  assert.deepEqual(withMissingCodexLive([], undefined, 'error'), [])
})
