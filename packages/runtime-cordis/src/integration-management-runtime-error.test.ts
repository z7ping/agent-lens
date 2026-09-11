import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import type { CapturePolicyService } from '@agent-lens/core'
import { IntegrationManagementService } from './integration-management'
import { IntegrationPreferenceService } from './integration-preferences'
import type { OfficialToolDiscoverySnapshot } from './tool-discovery'

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
  } as unknown as CapturePolicyService
}

test('one Integration runtime status failure does not reject the whole management projection', async () => {
  const path = join(tmpdir(), `agent-lens-integration-management-${process.pid}-runtime-error.json`)
  const preferences = new IntegrationPreferenceService(path, null)
  const discovery: OfficialToolDiscoverySnapshot = {
    status: 'complete',
    items: [],
    generatedAt: '2026-09-12T00:00:00.000Z',
  }
  const service = new IntegrationManagementService({
    discovery: { snapshot: () => discovery },
    preferences,
    capturePolicy: capturePolicy(),
    integrationStatus: productId => {
      if (productId === 'pi') return Promise.reject(new Error('Pi status failed'))
      return null
    },
  })

  try {
    const snapshot = await service.query()
    assert.equal(snapshot.items.length >= 5, true)
    assert.equal(
      snapshot.items.find(item => item.integrationId === 'pi')?.availability,
      'error',
    )
    assert.equal(
      snapshot.items.find(item => item.integrationId === 'codex')?.availability,
      'unavailable',
    )
  } finally {
    await rm(path, { force: true })
  }
})
