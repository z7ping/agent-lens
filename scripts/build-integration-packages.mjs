import { createHash } from 'node:crypto'
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const INTEGRATION_PACKAGE_SCHEMA_VERSION = 1
export const INTEGRATION_BUNDLE_SPECS = [
  { integrationId: 'pi', productId: 'pi', packageName: '@agent-lens/integration-pi', entry: 'packages/integration-pi/src/index.ts' },
  { integrationId: 'codex', productId: 'codex', packageName: '@agent-lens/integration-codex', entry: 'packages/integration-codex/src/index.ts' },
  { integrationId: 'claude-code', productId: 'claude-code', packageName: '@agent-lens/integration-claude', entry: 'packages/integration-claude/src/index.ts' },
  { integrationId: 'hermes', productId: 'hermes', packageName: '@agent-lens/integration-hermes', entry: 'packages/integration-hermes/src/index.ts' },
  { integrationId: 'opencode', productId: 'opencode', packageName: '@agent-lens/integration-opencode', entry: 'packages/integration-opencode/src/index.ts' },
]

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function packageVersion(root, spec) {
  const packagePath = resolve(root, dirname(spec.entry), '..', 'package.json')
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'))
  if (pkg.name !== spec.packageName) {
    throw new Error(`Integration package identity mismatch: ${spec.integrationId}: ${String(pkg.name)} != ${spec.packageName}`)
  }
  if (typeof pkg.version !== 'string' || !pkg.version) {
    throw new Error(`Integration package version missing: ${spec.packageName}`)
  }
  return pkg.version
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

  const catalogEntries = []
  for (const spec of INTEGRATION_BUNDLE_SPECS) {
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

    const manifest = {
      schemaVersion: INTEGRATION_PACKAGE_SCHEMA_VERSION,
      integrationId: spec.integrationId,
      productId: spec.productId,
      packageName: spec.packageName,
      version,
      apiVersion: '1.0',
      entry: 'index.mjs',
      entryExport: 'default',
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
    schemaVersion: INTEGRATION_PACKAGE_SCHEMA_VERSION,
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
  packageVersion,
  isDirectInvocation,
}
