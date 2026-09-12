import { createHash } from 'node:crypto'
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const AGENT_LENS_PACKAGE_PREFIX = '@agent-lens/'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function loadSourceModule(root, relativePath) {
  const result = await build({
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22.12',
    write: false,
    sourcemap: false,
    legalComments: 'none',
    treeShaking: true,
    entryPoints: [resolve(root, relativePath)],
    external: ['node:*'],
  })
  const source = result.outputFiles?.[0]?.text
  if (!source) throw new Error(`Source module build produced no output: ${relativePath}`)
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  return import(moduleUrl)
}

async function loadOfficialIntegrationCatalog(root) {
  const module = await loadSourceModule(root, 'packages/integration-catalog/src/catalog.ts')
  if (!Array.isArray(module.OFFICIAL_INTEGRATION_CATALOG)) {
    throw new Error('Official Integration Catalog export is unavailable')
  }
  return module.OFFICIAL_INTEGRATION_CATALOG
}

async function loadIntegrationPackageSchemaVersion(root) {
  const module = await loadSourceModule(root, 'packages/integration-packages/src/types.ts')
  const version = module.INTEGRATION_PACKAGE_SCHEMA_VERSION
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`Integration Package schema version is invalid: ${String(version)}`)
  }
  return version
}

function workspacePackageDirectory(packageName) {
  if (
    typeof packageName !== 'string'
    || !packageName.startsWith(AGENT_LENS_PACKAGE_PREFIX)
    || packageName.slice(AGENT_LENS_PACKAGE_PREFIX.length).includes('/')
  ) {
    throw new Error(`Official Integration package name is not a local AgentLens workspace package: ${String(packageName)}`)
  }
  return join('packages', packageName.slice(AGENT_LENS_PACKAGE_PREFIX.length))
}

function bundleSpecFromCatalogEntry(entry) {
  if (!entry?.package) {
    throw new Error(`Official Integration package descriptor is missing: ${String(entry?.integrationId ?? 'unknown')}`)
  }
  const packageDir = workspacePackageDirectory(entry.package.packageName)
  return {
    integrationId: entry.integrationId,
    productId: entry.productId,
    packageName: entry.package.packageName,
    apiVersion: entry.package.apiVersion,
    entryExport: entry.package.entryExport,
    entry: join(packageDir, 'src', 'index.ts'),
    packageJson: join(packageDir, 'package.json'),
  }
}

async function integrationBundleSpecs(root) {
  const catalog = await loadOfficialIntegrationCatalog(root)
  return catalog.map(bundleSpecFromCatalogEntry)
}

async function packageVersion(root, spec) {
  const packagePath = resolve(root, spec.packageJson)
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'))
  if (pkg.name !== spec.packageName) {
    throw new Error(`Integration package identity mismatch: ${spec.integrationId}: ${String(pkg.name)} != ${spec.packageName}`)
  }
  if (typeof pkg.version !== 'string' || !pkg.version) {
    throw new Error(`Integration package version missing: ${spec.packageName}`)
  }
  return pkg.version
}

function assertIntegrationRuntimeManifest(candidate, spec) {
  const manifest = candidate?.manifest
  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`Integration bundle ${spec.integrationId} has no runtime manifest`)
  }
  for (const [field, expected] of [
    ['integrationId', spec.integrationId],
    ['productId', spec.productId],
    ['apiVersion', spec.apiVersion],
  ]) {
    if (manifest[field] !== expected) {
      throw new Error(
        `Integration runtime manifest mismatch: ${spec.integrationId}: ${field}=${String(manifest[field])} != Catalog ${expected}`,
      )
    }
  }
  return manifest
}

async function validateBuiltIntegrationContract(entryPath, entryHash, spec) {
  const moduleUrl = `${pathToFileURL(entryPath).href}?agentlens-build=${entryHash}`
  const module = await import(moduleUrl)
  const candidate = module[spec.entryExport]
  assertIntegrationRuntimeManifest(candidate, spec)
}

function assertPortableBundle(source, integrationId) {
  const forbidden = [
    /(?:from\s*|import\s*\()\s*['"]@agent-lens\//,
    /(?:from\s*|import\s*\()\s*['"]@deepseek-ai\/cordis['"]/,
  ]
  for (const pattern of forbidden) {
    if (pattern.test(source)) {
      throw new Error(`Integration bundle ${integrationId} contains unresolved AgentLens/Cordis import`)
    }
  }
}

export async function buildIntegrationPackages({
  root = scriptRoot,
  outDir = resolve(root, 'dist', 'integration-packages'),
  clean = true,
} = {}) {
  if (clean) await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  const [specs, schemaVersion] = await Promise.all([
    integrationBundleSpecs(root),
    loadIntegrationPackageSchemaVersion(root),
  ])
  const catalogEntries = []
  for (const spec of specs) {
    const version = await packageVersion(root, spec)
    const packageDir = join(outDir, spec.integrationId, version)
    const entryPath = join(packageDir, 'index.mjs')
    await mkdir(packageDir, { recursive: true })

    await build({
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22.12',
      sourcemap: false,
      legalComments: 'none',
      treeShaking: true,
      entryPoints: [resolve(root, spec.entry)],
      outfile: entryPath,
      // Integration bundles are installed outside the AgentLens npm tree.
      // Bundle the full official Integration dependency closure so runtime
      // loading never relies on node_modules lookup from the user data dir.
      packages: 'bundle',
    })

    const entry = await readFile(entryPath)
    const source = entry.toString('utf8')
    assertPortableBundle(source, spec.integrationId)
    const entryHash = sha256(entry)
    await validateBuiltIntegrationContract(entryPath, entryHash, spec)

    const manifest = {
      schemaVersion,
      integrationId: spec.integrationId,
      productId: spec.productId,
      packageName: spec.packageName,
      version,
      apiVersion: spec.apiVersion,
      entry: 'index.mjs',
      entryExport: spec.entryExport,
      files: [{
        path: 'index.mjs',
        size: entry.byteLength,
        sha256: entryHash,
      }],
    }
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
    await writeFile(join(packageDir, 'manifest.json'), manifestText, 'utf8')

    catalogEntries.push({
      integrationId: spec.integrationId,
      productId: spec.productId,
      packageName: spec.packageName,
      version,
      relativeManifestPath: `${spec.integrationId}/${version}/manifest.json`,
      manifestSha256: sha256(Buffer.from(manifestText)),
    })
  }

  const catalog = {
    schemaVersion,
    entries: catalogEntries,
  }
  await writeFile(join(outDir, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
  return catalog
}

function isDirectInvocation(moduleUrl, invokedPath) {
  if (!invokedPath) return false
  return resolve(fileURLToPath(moduleUrl)) === resolve(invokedPath)
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  const requested = process.argv[2]
  await buildIntegrationPackages({
    outDir: requested ? resolve(process.cwd(), requested) : undefined,
  })
  console.log('[AgentLens] official Integration package bundles built')
}

export const integrationBundleInternals = {
  sha256,
  assertPortableBundle,
  assertIntegrationRuntimeManifest,
  validateBuiltIntegrationContract,
  loadSourceModule,
  loadOfficialIntegrationCatalog,
  loadIntegrationPackageSchemaVersion,
  workspacePackageDirectory,
  bundleSpecFromCatalogEntry,
  integrationBundleSpecs,
  packageVersion,
  isDirectInvocation,
}
