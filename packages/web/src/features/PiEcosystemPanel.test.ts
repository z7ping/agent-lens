import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentOverviewDto } from '@agent-lens/protocol'
import { piEcosystemUiInternals } from './PiEcosystemPanel'

function agent(input: Partial<AgentOverviewDto> = {}): AgentOverviewDto {
  return {
    sourceId: 'pi',
    productId: 'pi',
    displayName: 'Pi',
    supported: true,
    enabled: true,
    detected: true,
    installations: [],
    capabilities: [],
    assetInventory: [],
    usedAssets: [],
    assetInventoryStatus: 'available',
    ...input,
  }
}

test('Pi ecosystem local package matching groups assets by exact npm identity', () => {
  const value = agent({
    assetInventory: [{
      id: 'asset:skill:reviewer',
      type: 'skill',
      canonicalName: 'reviewer',
      bindings: [{
        id: 'binding:skill:reviewer',
        installationId: 'installation:pi',
        source: 'opaque-pi-resource-source',
        packageIdentity: 'npm:@example/pi-tools',
        version: '2.1.0',
        states: [],
      }],
    }, {
      id: 'asset:extension:tools',
      type: 'extension',
      canonicalName: 'tools',
      bindings: [{
        id: 'binding:extension:tools',
        installationId: 'installation:pi',
        source: 'opaque-pi-resource-source',
        packageIdentity: 'npm:@example/pi-tools',
        version: '2.1.0',
        states: [],
      }],
    }],
  })

  const packages = piEcosystemUiInternals.localPackages(value)
  const local = packages.get('npm:@example/pi-tools')
  assert.ok(local)
  assert.equal(local.assets.length, 2)
  assert.deepEqual(local.versions, ['2.1.0'])
})

test('Pi ecosystem only claims not-installed when every installation has complete package identity coverage', () => {
  const complete = agent({
    installations: [{
      id: 'installation:pi',
      packageIdentityCoverage: 'complete',
      firstSeenAt: '2026-09-18T00:00:00.000Z',
      lastSeenAt: '2026-09-18T00:00:00.000Z',
    }],
  })
  const partial = agent({
    installations: [{
      id: 'installation:pi',
      packageIdentityCoverage: 'partial',
      firstSeenAt: '2026-09-18T00:00:00.000Z',
      lastSeenAt: '2026-09-18T00:00:00.000Z',
    }],
  })
  const mixed = agent({
    installations: [{
      id: 'installation:pi-a',
      packageIdentityCoverage: 'complete',
      firstSeenAt: '2026-09-18T00:00:00.000Z',
      lastSeenAt: '2026-09-18T00:00:00.000Z',
    }, {
      id: 'installation:pi-b',
      packageIdentityCoverage: 'unknown',
      firstSeenAt: '2026-09-18T00:00:00.000Z',
      lastSeenAt: '2026-09-18T00:00:00.000Z',
    }],
  })

  assert.equal(piEcosystemUiInternals.packageInventoryComplete(complete), true)
  assert.equal(piEcosystemUiInternals.localPackageState(complete, undefined), 'not-installed')
  assert.equal(piEcosystemUiInternals.packageInventoryComplete(partial), false)
  assert.equal(piEcosystemUiInternals.packageInventoryComplete(mixed), false)
  assert.equal(piEcosystemUiInternals.localPackageState(partial, undefined), 'unknown')
  assert.equal(
    piEcosystemUiInternals.localPackageState(agent({ assetInventoryStatus: 'unavailable' }), undefined),
    'unknown',
  )
  assert.equal(
    piEcosystemUiInternals.localPackageState(partial, { assets: [], versions: [] }),
    'installed',
  )
})
