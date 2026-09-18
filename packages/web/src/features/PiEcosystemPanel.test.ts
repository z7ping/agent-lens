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

test('Pi ecosystem never infers not-installed from generic asset discovery coverage', () => {
  const genericComplete = agent({
    capabilities: [{
      name: 'asset-discovery',
      status: 'available',
      captureModes: ['static-scan'],
    }],
  })
  const packageIdentityComplete = agent({
    capabilities: [{
      name: 'package-identity-discovery',
      status: 'available',
      captureModes: ['static-scan'],
    }],
  })

  assert.equal(piEcosystemUiInternals.packageInventoryComplete(genericComplete), false)
  assert.equal(piEcosystemUiInternals.localPackageState(genericComplete, undefined), 'unknown')
  assert.equal(piEcosystemUiInternals.packageInventoryComplete(packageIdentityComplete), true)
  assert.equal(piEcosystemUiInternals.localPackageState(packageIdentityComplete, undefined), 'not-installed')
  assert.equal(
    piEcosystemUiInternals.localPackageState(agent({ assetInventoryStatus: 'unavailable' }), undefined),
    'unknown',
  )
  assert.equal(
    piEcosystemUiInternals.localPackageState(genericComplete, { assets: [], versions: [] }),
    'installed',
  )
})

test('Pi ecosystem monthly download formatter uses compact locale-aware numbers', () => {
  assert.match(piEcosystemUiInternals.formatMonthlyDownloads(939_700, 'zh-CN'), /93\.9万|94万/)
  assert.match(piEcosystemUiInternals.formatMonthlyDownloads(939_700, 'en-US'), /939\.7K|940K/)
})
