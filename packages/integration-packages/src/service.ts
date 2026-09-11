import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve,
  sep,
} from 'node:path'
import { AGENT_LENS_PLUGIN_API_VERSION } from '@agent-lens/core'
import {
  OFFICIAL_INTEGRATION_CATALOG,
  officialIntegrationCatalogEntry,
} from '@agent-lens/integration-catalog'
import {
  INTEGRATION_PACKAGE_SCHEMA_VERSION,
  type BundledIntegrationCatalog,
  type BundledIntegrationCatalogEntry,
  type IntegrationPackageCatalogItem,
  type IntegrationPackageManifest,
  type IntegrationPackageOperation,
  type IntegrationPackageOperationKind,
  type IntegrationPackageState,
} from './types'

const MAX_OPERATIONS = 128

interface InstalledPointer {
  schemaVersion: typeof INTEGRATION_PACKAGE_SCHEMA_VERSION
  integrationId: string
  version: string
  installedAt: string
  manifestSha256?: string | undefined
}

interface TrustedBundle {
  catalog: BundledIntegrationCatalogEntry
  manifest: IntegrationPackageManifest
  manifestText: string
  packageDir: string
}

export interface IntegrationPackageRemoveGuardResult {
  allowed: boolean
  reason?: string | undefined
}

export interface IntegrationPackageServiceOptions {
  bundleDir: string
  installRoot: string
  canRemove?: (
    integrationId: string,
  ) => IntegrationPackageRemoveGuardResult | Promise<IntegrationPackageRemoveGuardResult>
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function cloneState(state: IntegrationPackageState): IntegrationPackageState {
  return { ...state }
}

function cloneOperation(operation: IntegrationPackageOperation): IntegrationPackageOperation {
  return { ...operation }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 1000)
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (typeof code === 'string' && code) return code.toLowerCase()
  return 'package-operation-failed'
}

function assertOfficialIntegration(integrationId: string) {
  const normalized = integrationId.trim().toLowerCase()
  const entry = officialIntegrationCatalogEntry(normalized)
  if (!entry) throw new Error(`Unknown official Agent Integration: ${integrationId}`)
  return entry
}

function safeRelativePath(path: string): string {
  const value = path.trim()
  if (!value || isAbsolute(value)) throw new Error(`Unsafe Integration package path: ${path}`)
  const normalized = normalize(value).replaceAll('\\', '/')
  if (
    normalized === '..'
    || normalized.startsWith('../')
    || normalized.includes('/../')
    || normalized === '.'
  ) {
    throw new Error(`Unsafe Integration package path: ${path}`)
  }
  return normalized
}

function resolveWithin(root: string, relativePath: string): string {
  const safe = safeRelativePath(relativePath)
  const absoluteRoot = resolve(root)
  const path = resolve(absoluteRoot, safe)
  if (path !== absoluteRoot && !path.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`Integration package path escapes root: ${relativePath}`)
  }
  return path
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${errorMessage(error)}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function parseBundledCatalog(text: string): BundledIntegrationCatalog {
  const value = parseJsonObject(text, 'Integration bundle catalog')
  if (value.schemaVersion !== INTEGRATION_PACKAGE_SCHEMA_VERSION) {
    throw new Error(`Unsupported Integration bundle catalog schema: ${String(value.schemaVersion)}`)
  }
  if (!Array.isArray(value.entries)) throw new Error('Integration bundle catalog entries must be an array')

  const entries: BundledIntegrationCatalogEntry[] = value.entries.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Integration bundle catalog entry ${index} must be an object`)
    }
    const item = raw as Record<string, unknown>
    for (const key of [
      'integrationId',
      'productId',
      'packageName',
      'version',
      'relativeManifestPath',
      'manifestSha256',
    ] as const) {
      if (typeof item[key] !== 'string' || !item[key]) {
        throw new Error(`Integration bundle catalog entry ${index} has invalid ${key}`)
      }
    }
    return {
      integrationId: item.integrationId as string,
      productId: item.productId as string,
      packageName: item.packageName as string,
      version: item.version as string,
      relativeManifestPath: safeRelativePath(item.relativeManifestPath as string),
      manifestSha256: item.manifestSha256 as string,
    }
  })

  const ids = new Set<string>()
  for (const entry of entries) {
    if (ids.has(entry.integrationId)) {
      throw new Error(`Duplicate Integration bundle catalog entry: ${entry.integrationId}`)
    }
    ids.add(entry.integrationId)
  }
  return { schemaVersion: INTEGRATION_PACKAGE_SCHEMA_VERSION, entries }
}

function parsePackageManifest(text: string): IntegrationPackageManifest {
  const value = parseJsonObject(text, 'Integration package manifest')
  if (value.schemaVersion !== INTEGRATION_PACKAGE_SCHEMA_VERSION) {
    throw new Error(`Unsupported Integration package manifest schema: ${String(value.schemaVersion)}`)
  }
  for (const key of [
    'integrationId',
    'productId',
    'packageName',
    'version',
    'apiVersion',
    'entry',
    'entryExport',
  ] as const) {
    if (typeof value[key] !== 'string' || !value[key]) {
      throw new Error(`Integration package manifest has invalid ${key}`)
    }
  }
  if (value.entryExport !== 'default') {
    throw new Error(`Unsupported Integration package entry export: ${String(value.entryExport)}`)
  }
  if (!Array.isArray(value.files) || !value.files.length) {
    throw new Error('Integration package manifest files must be a non-empty array')
  }
  const files = value.files.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Integration package file ${index} must be an object`)
    }
    const file = raw as Record<string, unknown>
    if (typeof file.path !== 'string' || !file.path) {
      throw new Error(`Integration package file ${index} has invalid path`)
    }
    if (!Number.isSafeInteger(file.size) || (file.size as number) < 0) {
      throw new Error(`Integration package file ${index} has invalid size`)
    }
    if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(file.sha256)) {
      throw new Error(`Integration package file ${index} has invalid sha256`)
    }
    return {
      path: safeRelativePath(file.path),
      size: file.size as number,
      sha256: (file.sha256 as string).toLowerCase(),
    }
  })
  const entry = safeRelativePath(value.entry as string)
  if (!files.some(file => file.path === entry)) {
    throw new Error('Integration package entry must be listed in manifest files')
  }
  return {
    schemaVersion: INTEGRATION_PACKAGE_SCHEMA_VERSION,
    integrationId: value.integrationId as string,
    productId: value.productId as string,
    packageName: value.packageName as string,
    version: value.version as string,
    apiVersion: value.apiVersion as string,
    entry,
    entryExport: 'default',
    files,
  }
}

function parseInstalledPointer(text: string, integrationId: string): InstalledPointer {
  const value = parseJsonObject(text, `Installed Integration pointer ${integrationId}`)
  if (value.schemaVersion !== INTEGRATION_PACKAGE_SCHEMA_VERSION) {
    throw new Error(`Unsupported installed Integration pointer schema: ${String(value.schemaVersion)}`)
  }
  if (value.integrationId !== integrationId) {
    throw new Error(`Installed Integration pointer identity mismatch: ${String(value.integrationId)} != ${integrationId}`)
  }
  if (typeof value.version !== 'string' || !value.version) {
    throw new Error('Installed Integration pointer version is missing')
  }
  if (typeof value.installedAt !== 'string' || !Number.isFinite(Date.parse(value.installedAt))) {
    throw new Error('Installed Integration pointer installedAt is invalid')
  }
  const manifestSha256 = value.manifestSha256
  if (
    manifestSha256 !== undefined
    && (typeof manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(manifestSha256))
  ) {
    throw new Error('Installed Integration pointer manifestSha256 is invalid')
  }
  return {
    schemaVersion: INTEGRATION_PACKAGE_SCHEMA_VERSION,
    integrationId,
    version: value.version,
    installedAt: value.installedAt,
    ...(typeof manifestSha256 === 'string'
      ? { manifestSha256: manifestSha256.toLowerCase() }
      : {}),
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const temporary = join(parent, `.${randomUUID()}.tmp`)
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  })
  try {
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function verifyManifestFiles(
  packageDir: string,
  manifest: IntegrationPackageManifest,
): Promise<void> {
  for (const file of manifest.files) {
    const path = resolveWithin(packageDir, file.path)
    const content = await readFile(path)
    if (content.byteLength !== file.size) {
      throw new Error(`Integration package file size mismatch: ${file.path}`)
    }
    if (sha256(content) !== file.sha256) {
      throw new Error(`Integration package file checksum mismatch: ${file.path}`)
    }
  }
}

function compatibilityFor(apiVersion: string): IntegrationPackageState['compatibility'] {
  return apiVersion === AGENT_LENS_PLUGIN_API_VERSION ? 'compatible' : 'incompatible'
}

export class IntegrationPackageService {
  private bundled = new Map<string, TrustedBundle>()
  private states = new Map<string, IntegrationPackageState>()
  private readonly operations = new Map<string, IntegrationPackageOperation>()
  private readonly operationOrder: string[] = []
  private readonly queues = new Map<string, Promise<void>>()
  private bundleErrors = new Map<string, string>()
  private bundleSourceError: string | null = null
  private initialized = false

  constructor(private readonly options: IntegrationPackageServiceOptions) {}

  async initialize(): Promise<void> {
    await mkdir(this.options.installRoot, { recursive: true, mode: 0o700 })
    await this.cleanupTransientDirectories()
    try {
      await this.loadTrustedBundles()
      this.bundleSourceError = null
    } catch (error) {
      // Installed packages are self-describing and independently verifiable.
      // A missing/corrupt bundled catalog must block new installs/updates, not
      // make already-installed Integrations disappear during offline startup.
      this.bundleSourceError = errorMessage(error)
    }
    await this.reconcile()
    this.initialized = true
  }

  async ensureLegacyPhysicalization(
    integrationIds: readonly string[],
  ): Promise<{ migrated: boolean; operations: IntegrationPackageOperation[] }> {
    this.assertInitialized()
    const markerPath = join(this.options.installRoot, 'legacy-physicalization-v1.json')
    if (existsSync(markerPath)) return { migrated: false, operations: [] }

    const ids = [...new Set(integrationIds.map(id => assertOfficialIntegration(id).integrationId))]
    const operations: IntegrationPackageOperation[] = []
    for (const id of ids) {
      // Migration is reconcile-style and failure-isolated. A broken package
      // must not prevent another legacy-enabled Integration from becoming
      // usable, and the missing marker makes the failed item retry next start.
      operations.push(await this.install(id))
    }

    const completed = operations.every(operation => operation.status === 'completed')
    if (completed) {
      await writeJsonAtomic(markerPath, {
        schemaVersion: INTEGRATION_PACKAGE_SCHEMA_VERSION,
        completedAt: new Date().toISOString(),
        integrationIds: ids,
      })
    }
    // Successful installs happened before Runtime registration in this same
    // process, so reconcile them immediately even when another item failed.
    await this.reconcile()
    return { migrated: completed, operations }
  }

  catalog(): IntegrationPackageCatalogItem[] {
    this.assertInitialized()
    return OFFICIAL_INTEGRATION_CATALOG.map(entry => {
      const bundled = this.bundled.get(entry.integrationId)
      return {
        integrationId: entry.integrationId,
        productId: entry.productId,
        displayName: entry.displayName,
        packageName: entry.package.packageName,
        ...(bundled ? { availableVersion: bundled.manifest.version } : {}),
        apiVersion: entry.package.apiVersion,
        source: 'bundled' as const,
      }
    })
  }

  state(integrationId: string): IntegrationPackageState {
    this.assertInitialized()
    const entry = assertOfficialIntegration(integrationId)
    return cloneState(this.states.get(entry.integrationId) ?? this.emptyState(entry.integrationId))
  }

  statesSnapshot(): IntegrationPackageState[] {
    this.assertInitialized()
    return OFFICIAL_INTEGRATION_CATALOG.map(entry => this.state(entry.integrationId))
  }

  operation(operationId: string): IntegrationPackageOperation | null {
    const operation = this.operations.get(operationId)
    return operation ? cloneOperation(operation) : null
  }

  installedEntryPath(integrationId: string): string | null {
    const state = this.state(integrationId)
    return state.installed
      && state.integrity === 'verified'
      && state.compatibility === 'compatible'
      && state.entryPath
      ? state.entryPath
      : null
  }

  async reconcile(): Promise<IntegrationPackageState[]> {
    for (const entry of OFFICIAL_INTEGRATION_CATALOG) {
      this.states.set(entry.integrationId, await this.readInstalledState(entry.integrationId))
    }
    return OFFICIAL_INTEGRATION_CATALOG.map(entry =>
      cloneState(this.states.get(entry.integrationId) ?? this.emptyState(entry.integrationId))
    )
  }

  install(integrationId: string): Promise<IntegrationPackageOperation> {
    return this.enqueue(integrationId, 'install', async id => {
      const current = this.states.get(id) ?? await this.readInstalledState(id)
      if (
        current.installed
        && current.integrity === 'verified'
        && current.compatibility === 'compatible'
      ) {
        return 'Integration is already installed'
      }
      await this.installAvailable(id)
      return 'Integration installed'
    })
  }

  update(integrationId: string): Promise<IntegrationPackageOperation> {
    return this.enqueue(integrationId, 'update', async id => {
      const current = this.states.get(id) ?? await this.readInstalledState(id)
      if (!current.installed) throw new Error('Integration is not installed')
      const bundled = await this.requireAvailableBundle(id)
      if (
        current.installedVersion === bundled.manifest.version
        && current.integrity === 'verified'
        && current.compatibility === 'compatible'
      ) {
        return 'Integration is already at the available version'
      }
      await this.installAvailable(id)
      return 'Integration updated'
    })
  }

  remove(integrationId: string): Promise<IntegrationPackageOperation> {
    return this.enqueue(integrationId, 'remove', async id => {
      const current = this.states.get(id) ?? await this.readInstalledState(id)
      if (!current.installed) return 'Integration is already removed'
      const guard = await this.options.canRemove?.(id)
      if (guard && !guard.allowed) {
        const reason = guard.reason?.trim() || 'Integration is currently in use'
        const error = new Error(reason)
        Object.assign(error, { code: 'blocked' })
        throw error
      }

      const integrationRoot = this.integrationRoot(id)
      const trashRoot = join(this.options.installRoot, '.trash')
      await mkdir(trashRoot, { recursive: true, mode: 0o700 })
      const trash = join(trashRoot, `${id}-${randomUUID()}`)
      try {
        await rename(integrationRoot, trash)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code
        if (code !== 'ENOENT') throw error
      }
      this.states.set(id, this.emptyState(id, true))
      await rm(trash, { recursive: true, force: true }).catch(() => undefined)
      return 'Integration removed'
    })
  }

  private async installAvailable(integrationId: string): Promise<void> {
    const trusted = await this.requireAvailableBundle(integrationId)
    if (trusted.manifest.apiVersion !== AGENT_LENS_PLUGIN_API_VERSION) {
      throw Object.assign(
        new Error(
          `Integration API ${trusted.manifest.apiVersion} is incompatible with AgentLens ${AGENT_LENS_PLUGIN_API_VERSION}`,
        ),
        { code: 'incompatible' },
      )
    }

    await verifyManifestFiles(trusted.packageDir, trusted.manifest)
    const stagingRoot = join(this.options.installRoot, '.staging')
    const staging = join(stagingRoot, `${integrationId}-${randomUUID()}`)
    await mkdir(staging, { recursive: true, mode: 0o700 })
    try {
      await writeFile(join(staging, 'manifest.json'), trusted.manifestText, {
        encoding: 'utf8',
        mode: 0o600,
      })
      for (const file of trusted.manifest.files) {
        const source = resolveWithin(trusted.packageDir, file.path)
        const target = resolveWithin(staging, file.path)
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await copyFile(source, target)
      }
      await verifyManifestFiles(staging, trusted.manifest)

      const versionsRoot = join(this.integrationRoot(integrationId), 'versions')
      await mkdir(versionsRoot, { recursive: true, mode: 0o700 })
      const target = join(versionsRoot, trusted.manifest.version)
      if (existsSync(target)) {
        const existing = await this.verifyInstalledPackage(
          target,
          integrationId,
          trusted.manifest.version,
          sha256(trusted.manifestText),
        ).catch(() => null)
        if (!existing || existing.integrity !== 'verified') {
          const trashRoot = join(this.options.installRoot, '.trash')
          await mkdir(trashRoot, { recursive: true, mode: 0o700 })
          await rename(target, join(trashRoot, `${integrationId}-corrupt-${randomUUID()}`))
        }
      }
      if (!existsSync(target)) await rename(staging, target)
      else await rm(staging, { recursive: true, force: true })

      const manifestSha256 = sha256(trusted.manifestText)
      const verified = await this.verifyInstalledPackage(
        target,
        integrationId,
        trusted.manifest.version,
        manifestSha256,
      )
      const pointer: InstalledPointer = {
        schemaVersion: INTEGRATION_PACKAGE_SCHEMA_VERSION,
        integrationId,
        version: trusted.manifest.version,
        installedAt: new Date().toISOString(),
        manifestSha256,
      }
      await writeJsonAtomic(join(this.integrationRoot(integrationId), 'current.json'), pointer)
      this.states.set(integrationId, { ...verified, restartRequired: true })
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  private async loadTrustedBundles(): Promise<void> {
    const catalogPath = join(this.options.bundleDir, 'catalog.json')
    const catalogText = await readFile(catalogPath, 'utf8')
    const catalog = parseBundledCatalog(catalogText)
    const next = new Map<string, TrustedBundle>()

    const errors = new Map<string, string>()
    for (const item of catalog.entries) {
      try {
        const official = assertOfficialIntegration(item.integrationId)
        if (
          item.productId !== official.productId
          || item.packageName !== official.package.packageName
          || item.version !== official.package.bundledVersion
        ) {
          throw new Error(`Bundled Integration catalog identity mismatch: ${item.integrationId}`)
        }

        const manifestPath = resolveWithin(this.options.bundleDir, item.relativeManifestPath)
        const manifestText = await readFile(manifestPath, 'utf8')
        if (sha256(Buffer.from(manifestText)) !== item.manifestSha256.toLowerCase()) {
          throw new Error(`Bundled Integration manifest checksum mismatch: ${item.integrationId}`)
        }
        const manifest = parsePackageManifest(manifestText)
        if (
          manifest.integrationId !== official.integrationId
          || manifest.productId !== official.productId
          || manifest.packageName !== official.package.packageName
          || manifest.version !== item.version
          || manifest.apiVersion !== official.package.apiVersion
          || manifest.entryExport !== official.package.entryExport
        ) {
          throw new Error(`Bundled Integration manifest identity mismatch: ${item.integrationId}`)
        }
        const packageDir = dirname(manifestPath)
        // The bundled catalog + manifest are the release trust root. Large bundle
        // files are hashed only when that package is actually installed, keeping
        // startup O(installed packages) rather than O(all available packages).
        next.set(item.integrationId, {
          catalog: item,
          manifest,
          manifestText,
          packageDir,
        })
      } catch (error) {
        errors.set(item.integrationId, errorMessage(error))
      }
    }

    for (const official of OFFICIAL_INTEGRATION_CATALOG) {
      if (!next.has(official.integrationId) && !errors.has(official.integrationId)) {
        errors.set(
          official.integrationId,
          `Trusted Integration bundle is missing: ${official.integrationId}`,
        )
      }
    }
    this.bundled = next
    this.bundleErrors = errors
  }

  private async readInstalledState(integrationId: string): Promise<IntegrationPackageState> {
    const bundled = this.bundled.get(integrationId)
    const availableVersion = bundled?.manifest.version
    const pointerPath = join(this.integrationRoot(integrationId), 'current.json')
    let pointerText: string
    try {
      pointerText = await readFile(pointerPath, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code === 'ENOENT') return this.emptyState(integrationId)
      return {
        ...this.emptyState(integrationId),
        installed: true,
        integrity: 'invalid',
        reason: errorMessage(error),
      }
    }

    let pointer: InstalledPointer
    try {
      pointer = parseInstalledPointer(pointerText, integrationId)
    } catch (error) {
      return {
        ...this.emptyState(integrationId),
        installed: true,
        integrity: 'invalid',
        reason: errorMessage(error),
      }
    }

    const packageDir = join(this.integrationRoot(integrationId), 'versions', pointer.version)
    const trustedManifestSha256 = pointer.manifestSha256
      ?? (bundled?.manifest.version === pointer.version
        ? sha256(bundled.manifestText)
        : undefined)
    if (!trustedManifestSha256) {
      return {
        integrationId,
        installed: true,
        installedVersion: pointer.version,
        ...(availableVersion ? { availableVersion } : {}),
        compatibility: 'unknown',
        integrity: 'invalid',
        restartRequired: false,
        reason: 'Installed Integration pointer has no trusted manifest hash',
      }
    }
    const verified = await this.verifyInstalledPackage(
      packageDir,
      integrationId,
      pointer.version,
      trustedManifestSha256,
    ).catch(error => ({
        integrationId,
        installed: true,
        installedVersion: pointer.version,
        ...(availableVersion ? { availableVersion } : {}),
        compatibility: 'unknown' as const,
        integrity: 'invalid' as const,
        restartRequired: false,
        reason: errorMessage(error),
      }))
    return verified
  }

  private async verifyInstalledPackage(
    packageDir: string,
    integrationId: string,
    version: string,
    trustedManifestSha256?: string,
  ): Promise<IntegrationPackageState> {
    const manifestText = await readFile(join(packageDir, 'manifest.json'), 'utf8')
    if (trustedManifestSha256 && sha256(manifestText) !== trustedManifestSha256) {
      throw new Error(`Installed Integration manifest checksum mismatch: ${integrationId}`)
    }
    const manifest = parsePackageManifest(manifestText)
    const official = assertOfficialIntegration(integrationId)
    if (
      manifest.integrationId !== integrationId
      || manifest.productId !== official.productId
      || manifest.packageName !== official.package.packageName
      || manifest.version !== version
    ) {
      throw new Error(`Installed Integration manifest identity mismatch: ${integrationId}`)
    }
    await verifyManifestFiles(packageDir, manifest)
    const compatibility = compatibilityFor(manifest.apiVersion)
    const entryPath = resolveWithin(packageDir, manifest.entry)
    return {
      integrationId,
      installed: true,
      installedVersion: version,
      ...(this.bundled.get(integrationId)?.manifest.version
        ? { availableVersion: this.bundled.get(integrationId)!.manifest.version }
        : {}),
      compatibility,
      integrity: 'verified',
      restartRequired: false,
      entryPath,
      ...(compatibility === 'incompatible'
        ? { reason: `Integration API ${manifest.apiVersion} is incompatible with AgentLens ${AGENT_LENS_PLUGIN_API_VERSION}` }
        : {}),
    }
  }

  private emptyState(integrationId: string, restartRequired = false): IntegrationPackageState {
    const bundled = this.bundled.get(integrationId)
    return {
      integrationId,
      installed: false,
      ...(bundled ? { availableVersion: bundled.manifest.version } : {}),
      compatibility: bundled ? compatibilityFor(bundled.manifest.apiVersion) : 'unknown',
      integrity: 'unknown',
      restartRequired,
      ...(!bundled && (this.bundleErrors.get(integrationId) || this.bundleSourceError)
        ? {
            reason: `Bundled Integration source unavailable: ${
              this.bundleErrors.get(integrationId) ?? this.bundleSourceError
            }`,
          }
        : {}),
    }
  }

  private async requireAvailableBundle(integrationId: string): Promise<TrustedBundle> {
    const current = this.bundled.get(integrationId)
    if (current) return current
    try {
      await this.loadTrustedBundles()
      this.bundleSourceError = null
    } catch (error) {
      this.bundleSourceError = errorMessage(error)
      throw Object.assign(
        new Error(`Bundled Integration source unavailable: ${this.bundleSourceError}`),
        { code: 'bundle-source-unavailable' },
      )
    }
    const bundled = this.bundled.get(integrationId)
    if (!bundled) {
      const reason = this.bundleErrors.get(integrationId)
        ?? `No trusted bundled package is available for ${integrationId}`
      throw Object.assign(
        new Error(reason),
        { code: 'bundle-source-unavailable' },
      )
    }
    return bundled
  }

  private integrationRoot(integrationId: string): string {
    return join(this.options.installRoot, assertOfficialIntegration(integrationId).integrationId)
  }

  private enqueue(
    integrationId: string,
    kind: IntegrationPackageOperationKind,
    action: (integrationId: string) => Promise<string>,
  ): Promise<IntegrationPackageOperation> {
    this.assertInitialized()
    const id = assertOfficialIntegration(integrationId).integrationId
    const operation: IntegrationPackageOperation = {
      operationId: randomUUID(),
      integrationId: id,
      kind,
      status: 'queued',
      startedAt: new Date().toISOString(),
    }
    this.operations.set(operation.operationId, operation)
    this.operationOrder.push(operation.operationId)
    this.pruneOperations()

    const previous = this.queues.get(id) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(async () => {
      operation.status = 'running'
      try {
        operation.message = await action(id)
        operation.status = 'completed'
      } catch (error) {
        operation.status = 'failed'
        operation.errorCode = errorCode(error)
        operation.message = errorMessage(error)
      } finally {
        operation.completedAt = new Date().toISOString()
        this.pruneOperations()
      }
    })
    const queued = run.then(() => undefined, () => undefined)
    this.queues.set(id, queued)
    void queued.finally(() => {
      if (this.queues.get(id) === queued) this.queues.delete(id)
    })
    return run.then(() => cloneOperation(operation))
  }

  private pruneOperations(): void {
    while (this.operationOrder.length > MAX_OPERATIONS) {
      const index = this.operationOrder.findIndex(id => {
        const status = this.operations.get(id)?.status
        return status === undefined || status === 'failed' || status === 'completed'
      })
      if (index < 0) break
      const [id] = this.operationOrder.splice(index, 1)
      if (id) this.operations.delete(id)
    }
  }

  private async cleanupTransientDirectories(): Promise<void> {
    for (const name of ['.staging', '.trash']) {
      const root = join(this.options.installRoot, name)
      let entries: string[] = []
      try {
        entries = await readdir(root)
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error
      }
      for (const entry of entries) {
        await rm(join(root, entry), { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('Integration Package Service is not initialized')
  }
}

export const integrationPackageInternals = {
  sha256,
  safeRelativePath,
  resolveWithin,
  parseBundledCatalog,
  parsePackageManifest,
  parseInstalledPointer,
  writeJsonAtomic,
  verifyManifestFiles,
  compatibilityFor,
}
