import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  integrationBundleInternals,
} from './build-integration-packages.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('Integration package schema version is loaded from the package contract source', async () => {
  assert.equal(
    await integrationBundleInternals.loadIntegrationPackageSchemaVersion(root),
    1,
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
  assert.equal(specs.every(item => item.apiVersion === '1.0'), true)
  assert.equal(specs.every(item => item.entryExport === 'default'), true)
  assert.equal(specs.some(item => 'bundledVersion' in item), false)
})

test('runtime Integration manifest must match Official Catalog identity and Plugin API', () => {
  const spec = {
    integrationId: 'pi',
    productId: 'pi',
    apiVersion: '1.0',
  }

  assert.doesNotThrow(() => integrationBundleInternals.assertIntegrationRuntimeManifest({
    manifest: {
      integrationId: 'pi',
      productId: 'pi',
      apiVersion: '1.0',
    },
  }, spec))

  assert.throws(
    () => integrationBundleInternals.assertIntegrationRuntimeManifest({
      manifest: {
        integrationId: 'pi',
        productId: 'codex',
        apiVersion: '1.0',
      },
    }, spec),
    /productId=codex != Catalog pi/,
  )
  assert.throws(
    () => integrationBundleInternals.assertIntegrationRuntimeManifest({
      manifest: {
        integrationId: 'pi',
        productId: 'pi',
        apiVersion: '2.0',
      },
    }, spec),
    /apiVersion=2\.0 != Catalog 1\.0/,
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

test('bundle spec keeps package identity, API version and entry export from Catalog metadata', () => {
  assert.deepEqual(
    integrationBundleInternals.bundleSpecFromCatalogEntry({
      integrationId: 'example',
      productId: 'example-product',
      package: {
        packageName: '@agent-lens/integration-example',
        apiVersion: '1.0',
        entryExport: 'default',
      },
    }),
    {
      integrationId: 'example',
      productId: 'example-product',
      packageName: '@agent-lens/integration-example',
      apiVersion: '1.0',
      entryExport: 'default',
      entry: join('packages', 'integration-example', 'src', 'index.ts'),
      packageJson: join('packages', 'integration-example', 'package.json'),
    },
  )
})
