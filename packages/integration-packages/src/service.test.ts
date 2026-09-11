import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { OFFICIAL_INTEGRATION_CATALOG } from '@agent-lens/integration-catalog'
import { IntegrationPackageService } from './service'
import {
  INTEGRATION_PACKAGE_SCHEMA_VERSION,
  type BundledIntegrationCatalogEntry,
} from './types'

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

async function writeTrustedBundle(bundleDir: string) {
  await mkdir(bundleDir, { recursive: true })
  const entries: BundledIntegrationCatalogEntry[] = []
  const entryFiles = new Map<string, { path: string; content: string }>()

  for (const integration of OFFICIAL_INTEGRATION_CATALOG) {
    const packageDir = join(bundleDir, integration.integrationId)
    await mkdir(packageDir, { recursive: true })
    const entryContent = `export default { id: '${integration.integrationId}' }\n`
    const entryPath = join(packageDir, 'index.js')
    await writeFile(entryPath, entryContent, 'utf8')
    entryFiles.set(integration.integrationId, { path: entryPath, content: entryContent })

    const manifest = {
      schemaVersion: INTEGRATION_PACKAGE_SCHEMA_VERSION,
      integrationId: integration.integrationId,
      productId: integration.productId,
      packageName: integration.package.packageName,
      version: integration.package.bundledVersion,
      apiVersion: integration.package.apiVersion,
      entry: 'index.js',
      entryExport: integration.package.entryExport,
      files: [{
        path: 'index.js',
        size: Buffer.byteLength(entryContent),
        sha256: sha256(entryContent),
      }],
    }
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
    const relativeManifestPath = `${integration.integrationId}/manifest.json`
    await writeFile(join(bundleDir, relativeManifestPath), manifestText, 'utf8')
    entries.push({
      integrationId: integration.integrationId,
      productId: integration.productId,
      packageName: integration.package.packageName,
      version: integration.package.bundledVersion,
      relativeManifestPath,
      manifestSha256: sha256(manifestText),
    })
  }

  await writeFile(join(bundleDir, 'catalog.json'), `${JSON.stringify({
    schemaVersion: INTEGRATION_PACKAGE_SCHEMA_VERSION,
    entries,
  }, null, 2)}\n`, 'utf8')

  return { entryFiles }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-integration-packages-'))
  const bundleDir = join(root, 'bundles')
  const installRoot = join(root, 'integrations')
  const bundle = await writeTrustedBundle(bundleDir)
  return {
    root,
    bundleDir,
    installRoot,
    bundle,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

test('installed Integration remains verifiable and loadable when bundled catalog is unavailable', async () => {
  const f = await fixture()
  try {
    const online = new IntegrationPackageService({
      bundleDir: f.bundleDir,
      installRoot: f.installRoot,
    })
    await online.initialize()
    assert.equal((await online.install('pi')).status, 'completed')
    assert.equal(online.state('pi').installed, true)

    await rename(f.bundleDir, `${f.bundleDir}.offline`)

    const offline = new IntegrationPackageService({
      bundleDir: f.bundleDir,
      installRoot: f.installRoot,
    })
    await offline.initialize()

    const installed = offline.state('pi')
    assert.equal(installed.installed, true)
    assert.equal(installed.integrity, 'verified')
    assert.equal(installed.compatibility, 'compatible')
    assert.ok(offline.installedEntryPath('pi'))
    assert.equal(installed.availableVersion, undefined)

    const unavailableInstall = await offline.install('codex')
    assert.equal(unavailableInstall.status, 'failed')
    assert.equal(unavailableInstall.errorCode, 'bundle-source-unavailable')
    assert.match(unavailableInstall.message ?? '', /Bundled Integration source unavailable/)
  } finally {
    await f.cleanup()
  }
})

test('legacy physicalization isolates one broken package and retries only until the whole selection is reconciled', async () => {
  const f = await fixture()
  try {
    const service = new IntegrationPackageService({
      bundleDir: f.bundleDir,
      installRoot: f.installRoot,
    })
    await service.initialize()

    const piEntry = f.bundle.entryFiles.get('pi')
    assert.ok(piEntry)
    await writeFile(piEntry.path, 'corrupt\n', 'utf8')

    const first = await service.ensureLegacyPhysicalization(['pi', 'codex'])
    assert.equal(first.migrated, false)
    assert.deepEqual(first.operations.map(item => [item.integrationId, item.status]), [
      ['pi', 'failed'],
      ['codex', 'completed'],
    ])
    assert.equal(service.state('pi').installed, false)
    assert.equal(service.state('codex').installed, true)
    assert.equal(
      existsSync(join(f.installRoot, 'legacy-physicalization-v1.json')),
      false,
    )

    await writeFile(piEntry.path, piEntry.content, 'utf8')
    const second = await service.ensureLegacyPhysicalization(['pi', 'codex'])
    assert.equal(second.migrated, true)
    assert.equal(second.operations.every(item => item.status === 'completed'), true)
    assert.equal(service.state('pi').installed, true)
    assert.equal(service.state('codex').installed, true)
    assert.equal(
      existsSync(join(f.installRoot, 'legacy-physicalization-v1.json')),
      true,
    )
  } finally {
    await f.cleanup()
  }
})

test('failed update keeps the previously committed version current and loadable', async () => {
  const f = await fixture()
  try {
    const initial = new IntegrationPackageService({
      bundleDir: f.bundleDir,
      installRoot: f.installRoot,
    })
    await initial.initialize()
    assert.equal((await initial.install('pi')).status, 'completed')

    const integration = OFFICIAL_INTEGRATION_CATALOG.find(item => item.integrationId === 'pi')
    assert.ok(integration)
    const versionsRoot = join(f.installRoot, 'pi', 'versions')
    const oldVersion = '0.9.0-test'
    const oldDir = join(versionsRoot, oldVersion)
    await rename(join(versionsRoot, integration.package.bundledVersion), oldDir)

    const manifestPath = join(oldDir, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.version = oldVersion
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
    await writeFile(manifestPath, manifestText, 'utf8')

    const pointerPath = join(f.installRoot, 'pi', 'current.json')
    const pointer = JSON.parse(await readFile(pointerPath, 'utf8')) as Record<string, unknown>
    pointer.version = oldVersion
    pointer.manifestSha256 = sha256(manifestText)
    await writeFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8')

    const service = new IntegrationPackageService({
      bundleDir: f.bundleDir,
      installRoot: f.installRoot,
    })
    await service.initialize()
    assert.equal(service.state('pi').installedVersion, oldVersion)
    assert.equal(service.state('pi').availableVersion, integration.package.bundledVersion)

    const bundledEntry = f.bundle.entryFiles.get('pi')
    assert.ok(bundledEntry)
    await writeFile(bundledEntry.path, 'broken update payload\n', 'utf8')

    const update = await service.update('pi')
    assert.equal(update.status, 'failed')
    assert.equal(service.state('pi').installedVersion, oldVersion)
    assert.ok(service.installedEntryPath('pi'))

    const current = JSON.parse(await readFile(pointerPath, 'utf8')) as Record<string, unknown>
    assert.equal(current.version, oldVersion)
  } finally {
    await f.cleanup()
  }
})

test('startup cleans interrupted staging/trash work without disturbing the committed current pointer', async () => {
  const f = await fixture()
  try {
    const service = new IntegrationPackageService({
      bundleDir: f.bundleDir,
      installRoot: f.installRoot,
    })
    await service.initialize()
    assert.equal((await service.install('pi')).status, 'completed')

    await mkdir(join(f.installRoot, '.staging', 'partial-install'), { recursive: true })
    await writeFile(join(f.installRoot, '.staging', 'partial-install', 'partial'), 'x')
    await mkdir(join(f.installRoot, '.trash', 'partial-remove'), { recursive: true })
    await writeFile(join(f.installRoot, '.trash', 'partial-remove', 'partial'), 'x')

    const recovered = new IntegrationPackageService({
      bundleDir: f.bundleDir,
      installRoot: f.installRoot,
    })
    await recovered.initialize()

    assert.equal(recovered.state('pi').installed, true)
    assert.equal(recovered.state('pi').integrity, 'verified')
    assert.deepEqual(await readdir(join(f.installRoot, '.staging')), [])
    assert.deepEqual(await readdir(join(f.installRoot, '.trash')), [])
  } finally {
    await f.cleanup()
  }
})

test('startup completes an interrupted remove whose Integration root was already moved to trash', async () => {
  const f = await fixture()
  try {
    const service = new IntegrationPackageService({
      bundleDir: f.bundleDir,
      installRoot: f.installRoot,
    })
    await service.initialize()
    assert.equal((await service.install('pi')).status, 'completed')

    const trashRoot = join(f.installRoot, '.trash')
    await mkdir(trashRoot, { recursive: true })
    await rename(
      join(f.installRoot, 'pi'),
      join(trashRoot, 'pi-interrupted-remove'),
    )

    const recovered = new IntegrationPackageService({
      bundleDir: f.bundleDir,
      installRoot: f.installRoot,
    })
    await recovered.initialize()

    assert.equal(recovered.state('pi').installed, false)
    assert.deepEqual(await readdir(trashRoot), [])
  } finally {
    await f.cleanup()
  }
})

test('installed manifest cannot self-authorize coordinated manifest and file tampering', async () => {
  const f = await fixture()
  try {
    const service = new IntegrationPackageService({
      bundleDir: f.bundleDir,
      installRoot: f.installRoot,
    })
    await service.initialize()
    assert.equal((await service.install('pi')).status, 'completed')

    const integration = OFFICIAL_INTEGRATION_CATALOG.find(item => item.integrationId === 'pi')
    assert.ok(integration)
    const packageDir = join(
      f.installRoot,
      'pi',
      'versions',
      integration.package.bundledVersion,
    )
    const entryPath = join(packageDir, 'index.js')
    const manifestPath = join(packageDir, 'manifest.json')
    const tamperedEntry = "export default { id: 'pi', tampered: true }\n"
    await writeFile(entryPath, tamperedEntry, 'utf8')

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      files: Array<{ path: string; size: number; sha256: string }>
    }
    const entry = manifest.files.find(file => file.path === 'index.js')
    assert.ok(entry)
    entry.size = Buffer.byteLength(tamperedEntry)
    entry.sha256 = sha256(tamperedEntry)
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    const recovered = new IntegrationPackageService({
      bundleDir: f.bundleDir,
      installRoot: f.installRoot,
    })
    await recovered.initialize()

    const state = recovered.state('pi')
    assert.equal(state.installed, true)
    assert.equal(state.integrity, 'invalid')
    assert.match(state.reason ?? '', /manifest checksum mismatch/)
    assert.equal(recovered.installedEntryPath('pi'), null)
  } finally {
    await f.cleanup()
  }
})

test('installed package with incompatible Plugin API stays installed but is not loadable', async () => {
  const f = await fixture()
  try {
    const service = new IntegrationPackageService({
      bundleDir: f.bundleDir,
      installRoot: f.installRoot,
    })
    await service.initialize()
    assert.equal((await service.install('pi')).status, 'completed')

    const integration = OFFICIAL_INTEGRATION_CATALOG.find(item => item.integrationId === 'pi')
    assert.ok(integration)
    const manifestPath = join(
      f.installRoot,
      'pi',
      'versions',
      integration.package.bundledVersion,
      'manifest.json',
    )
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.apiVersion = '999.0'
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
    await writeFile(manifestPath, manifestText, 'utf8')

    // Simulate a package that was trusted by the previous Core version: the
    // pointer still anchors the exact manifest, while the new Core rejects its
    // Plugin API as incompatible rather than mislabeling it as corrupt.
    const pointerPath = join(f.installRoot, 'pi', 'current.json')
    const pointer = JSON.parse(await readFile(pointerPath, 'utf8')) as Record<string, unknown>
    pointer.manifestSha256 = sha256(manifestText)
    await writeFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8')

    const upgradedCore = new IntegrationPackageService({
      bundleDir: f.bundleDir,
      installRoot: f.installRoot,
    })
    await upgradedCore.initialize()

    const state = upgradedCore.state('pi')
    assert.equal(state.installed, true)
    assert.equal(state.integrity, 'verified')
    assert.equal(state.compatibility, 'incompatible')
    assert.match(state.reason ?? '', /incompatible/)
    assert.equal(upgradedCore.installedEntryPath('pi'), null)
  } finally {
    await f.cleanup()
  }
})

test('install repairs an already-installed incompatible package before reporting success', async () => {
  const f = await fixture()
  try {
    const service = new IntegrationPackageService({
      bundleDir: f.bundleDir,
      installRoot: f.installRoot,
    })
    await service.initialize()
    assert.equal((await service.install('pi')).status, 'completed')

    const integration = OFFICIAL_INTEGRATION_CATALOG.find(item => item.integrationId === 'pi')
    assert.ok(integration)
    const manifestPath = join(
      f.installRoot,
      'pi',
      'versions',
      integration.package.bundledVersion,
      'manifest.json',
    )
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.apiVersion = '999.0'
    const incompatibleManifestText = `${JSON.stringify(manifest, null, 2)}\n`
    await writeFile(manifestPath, incompatibleManifestText, 'utf8')

    const pointerPath = join(f.installRoot, 'pi', 'current.json')
    const pointer = JSON.parse(await readFile(pointerPath, 'utf8')) as Record<string, unknown>
    pointer.manifestSha256 = sha256(incompatibleManifestText)
    await writeFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8')

    const restarted = new IntegrationPackageService({
      bundleDir: f.bundleDir,
      installRoot: f.installRoot,
    })
    await restarted.initialize()
    assert.equal(restarted.state('pi').compatibility, 'incompatible')

    const install = await restarted.install('pi')
    assert.equal(install.status, 'completed')
    assert.equal(restarted.state('pi').compatibility, 'compatible')
    assert.equal(restarted.state('pi').integrity, 'verified')
    assert.ok(restarted.installedEntryPath('pi'))
  } finally {
    await f.cleanup()
  }
})

test('removing Integration package leaves data outside package install root untouched', async () => {
  const f = await fixture()
  try {
    const historyPath = join(f.root, 'agent-lens-history.db')
    const authorizationPath = join(f.root, 'integration-authorization.json')
    await writeFile(historyPath, 'history-fact', 'utf8')
    await writeFile(authorizationPath, '{"grants":{"pi":["live"]}}\n', 'utf8')

    const service = new IntegrationPackageService({
      bundleDir: f.bundleDir,
      installRoot: f.installRoot,
    })
    await service.initialize()
    assert.equal((await service.install('pi')).status, 'completed')
    assert.equal((await service.remove('pi')).status, 'completed')

    assert.equal(service.state('pi').installed, false)
    assert.equal(await readFile(historyPath, 'utf8'), 'history-fact')
    assert.equal(
      await readFile(authorizationPath, 'utf8'),
      '{"grants":{"pi":["live"]}}\n',
    )
  } finally {
    await f.cleanup()
  }
})
