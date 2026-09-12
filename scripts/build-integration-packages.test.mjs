import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  integrationBundleInternals,
} from './build-integration-packages.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('Integration package protocol is loaded from the package contract source', async () => {
  assert.deepEqual(
    await integrationBundleInternals.loadIntegrationPackageContract(root),
    {
      schemaVersion: 1,
      entryExport: 'default',
    },
  )
  assert.equal(
    await integrationBundleInternals.loadPluginApiVersion(root),
    '1.0',
  )
})

test('Integration bundle specs are derived from the Official Catalog instead of a handwritten build list', async () => {
  const specs = await integrationBundleInternals.integrationBundleSpecs(root)

  assert.deepEqual(
    specs.map(item => item.integrationId),
    ['pi', 'codex', 'claude-code', 'hermes', 'opencode'],
  )
  assert.deepEqual(
    specs.map(item => item.entry),
    [
      join('packages', 'integration-pi', 'src', 'index.ts'),
      join('packages', 'integration-codex', 'src', 'index.ts'),
      join('packages', 'integration-claude', 'src', 'index.ts'),
      join('packages', 'integration-hermes', 'src', 'index.ts'),
      join('packages', 'integration-opencode', 'src', 'index.ts'),
    ],
  )
  assert.deepEqual(
    specs.map(item => item.manifestEntry),
    [
      join('packages', 'integration-pi', 'src', 'manifest.ts'),
      join('packages', 'integration-codex', 'src', 'manifest.ts'),
      join('packages', 'integration-claude', 'src', 'manifest.ts'),
      join('packages', 'integration-hermes', 'src', 'manifest.ts'),
      join('packages', 'integration-opencode', 'src', 'manifest.ts'),
    ],
  )
  assert.equal(specs.some(item => 'apiVersion' in item), false)
  assert.equal(specs.some(item => 'entryExport' in item), false)
  assert.equal(specs.some(item => 'bundledVersion' in item), false)
})

test('build contract loads pure Integration manifest modules without loading runtime components', async () => {
  const specs = await integrationBundleInternals.integrationBundleSpecs(root)
  const pi = specs.find(item => item.integrationId === 'pi')
  assert.ok(pi)
  assert.deepEqual(
    await integrationBundleInternals.loadIntegrationRuntimeManifest(root, pi, '1.0'),
    {
      integrationId: 'pi',
      productId: 'pi',
      displayName: 'Pi',
      apiVersion: '1.0',
      capabilities: ['source', 'runtime', 'live'],
      componentPluginIds: [
        '@agent-lens/source-pi',
        '@agent-lens/runtime-cordis/pi-live',
      ],
    },
  )
})

test('runtime Integration manifest must match Official Catalog identity and Plugin API', () => {
  const spec = {
    integrationId: 'pi',
    productId: 'pi',
  }

  assert.doesNotThrow(() => integrationBundleInternals.assertIntegrationRuntimeManifest({
    manifest: {
      integrationId: 'pi',
      productId: 'pi',
      apiVersion: '1.0',
    },
  }, spec, '1.0'))

  assert.throws(
    () => integrationBundleInternals.assertIntegrationRuntimeManifest({
      manifest: {
        integrationId: 'pi',
        productId: 'codex',
        apiVersion: '1.0',
      },
    }, spec, '1.0'),
    /productId=codex != expected pi/,
  )
  assert.throws(
    () => integrationBundleInternals.assertIntegrationRuntimeManifest({
      manifest: {
        integrationId: 'pi',
        productId: 'pi',
        apiVersion: '2.0',
      },
    }, spec, '1.0'),
    /apiVersion=2\.0 != expected 1\.0/,
  )
})

test('workspace package path derivation rejects non-AgentLens and nested package names', () => {
  assert.equal(
    integrationBundleInternals.workspacePackageDirectory('@agent-lens/integration-pi'),
    join('packages', 'integration-pi'),
  )
  assert.throws(
    () => integrationBundleInternals.workspacePackageDirectory('@other/integration-pi'),
    /not a local AgentLens workspace package/,
  )
  assert.throws(
    () => integrationBundleInternals.workspacePackageDirectory('@agent-lens/nested/integration-pi'),
    /not a local AgentLens workspace package/,
  )
})

test('bundle spec keeps only package identity and workspace location from Catalog metadata', () => {
  assert.deepEqual(
    integrationBundleInternals.bundleSpecFromCatalogEntry({
      integrationId: 'example',
      productId: 'example-product',
      package: {
        packageName: '@agent-lens/integration-example',
      },
    }),
    {
      integrationId: 'example',
      productId: 'example-product',
      packageName: '@agent-lens/integration-example',
      entry: join('packages', 'integration-example', 'src', 'index.ts'),
      manifestEntry: join('packages', 'integration-example', 'src', 'manifest.ts'),
      packageJson: join('packages', 'integration-example', 'package.json'),
    },
  )
})
