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

test('Pi ecosystem local identity parser extracts exact npm package from Pi package source', () => {
  assert.equal(
    piEcosystemUiInternals.npmPackageSource('pi:resource:user:package:npm:pi-demo@^1.0.0'),
    'npm:pi-demo',
  )
  assert.equal(
    piEcosystemUiInternals.npmPackageSource('pi:resource:user:package:npm:@example/pi-tools@~2.0.0'),
    'npm:@example/pi-tools',
  )
  assert.equal(
    piEcosystemUiInternals.npmPackageSource('pi:resource:user:auto:/tmp/skill'),
    undefined,
  )
})

test('Pi ecosystem local package matching groups assets by exact npm identity', () => {
  const value = agent({
    assetInventory: [{
      id: 'asset:skill:reviewer',
      type: 'skill',
      canonicalName: 'reviewer',
      bindings: [{
        id: 'binding:skill:reviewer',
        installationId: 'installation:pi',
        source: 'pi:resource:user:package:npm:@example/pi-tools@^2',
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
        source: 'pi:resource:user:package:npm:@example/pi-tools@^2',
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

test('Pi ecosystem only claims not-installed when local asset discovery is complete', () => {
  const complete = agent({
    capabilities: [{
      name: 'asset-discovery',
      status: 'available',
      captureModes: ['static-scan'],
    }],
  })
  const partial = agent({
    capabilities: [{
      name: 'asset-discovery',
      status: 'partial',
      captureModes: ['static-scan'],
    }],
  })

  assert.equal(piEcosystemUiInternals.packageInventoryComplete(complete), true)
  assert.equal(piEcosystemUiInternals.localPackageState(complete, undefined), 'not-installed')
  assert.equal(piEcosystemUiInternals.packageInventoryComplete(partial), false)
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