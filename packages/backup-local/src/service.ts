import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { arch, hostname, platform } from 'node:os'
import {
  basename,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import type {
  AgentInstallation,
  BackupAssetKind,
  BackupCreateInput,
  BackupExcludedEntry,
  BackupManifestFile,
  BackupOverview,
  BackupProtectionSource,
  BackupRestorePreview,
  BackupRestorePreviewEntry,
  BackupService,
  BackupSnapshotManifest,
  BackupSnapshotSummary,
  BackupSourceScope,
  BackupVerifyResult,
  DetectedSource,
  Host,
  IdentityService,
  SourceCheckpointService,
  SourceDefinition,
  SourceService,
  StorageService,
} from '@agent-lens/core'

const MANIFEST_SCHEMA_VERSION = 1 as const
const BUNDLE_VERSION = 1 as const
const INVENTORY_VERSION = 1 as const
const INDEX_REFRESH_INTERVAL_MS = 5 * 60 * 1000
const INDEX_STARTUP_STALE_MS = 60 * 1000
const MAX_IMPORT_BYTES = 256 * 1024 * 1024
const MAX_BUNDLE_JSON_BYTES = 768 * 1024 * 1024
const SENSITIVE_FILE_NAME = /(?:^|[._-])(auth|credentials?|secrets?|tokens?)(?:[._-]|$)|\.(?:pem|key)$|^id_(?:rsa|ed25519)$/i
const HIGH_CONFIDENCE_SECRET = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]{24,}|\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}/i
const CONFIG_SECRET_ASSIGNMENT = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|authorization|private[_-]?key)\s*["']?\s*[:=]\s*["']?(?!\$\{)[^"'\s,}\]]{6,}/i

interface BackupTarget {
  source: SourceDefinition
  detected: DetectedSource
  host: Host
  installation: AgentInstallation
}

interface CandidateRoot {
  target: BackupTarget
  path: string
  scope: BackupSourceScope
  rootPath: string
  kinds: Set<BackupAssetKind>
}

interface CandidateFile {
  sourceId: string
  productId: string
  installationId: string
  path: string
  scope: BackupSourceScope
  sourceRelativePath: string
  archivePath: string
  kinds: Set<BackupAssetKind>
  size: number
  mtimeMs: number
  ctimeMs: number
}

interface BackupPlan {
  files: CandidateFile[]
  excluded: BackupExcludedEntry[]
  targets: BackupTarget[]
}

interface BackupIndexedFile {
  sourceId: string
  productId: string
  installationId: string
  originalPath: string
  sourceScope: BackupSourceScope
  sourceRelativePath: string
  archivePath: string
  kinds: BackupAssetKind[]
  size: number
  mtimeMs: number
  ctimeMs: number
  sha256?: string
}

interface BackupInventory {
  version: 1
  generatedAt: string
  sources: BackupProtectionSource[]
  files: BackupIndexedFile[]
  excluded: BackupExcludedEntry[]
}

interface BackupBundleFile {
  archivePath: string
  dataBase64: string
}

interface BackupBundle {
  bundleVersion: 1
  manifest: BackupSnapshotManifest
  files: BackupBundleFile[]
}

interface HashUpdate {
  size: number
  mtimeMs: number
  ctimeMs: number
  sha256: string
}

class ScopedCheckpointService implements SourceCheckpointService {
  constructor(
    private readonly storage: StorageService,
    private readonly scope: string,
  ) {}

  get<T>(key: string): Promise<T | null> {
    return this.storage.checkpoints.get<T>(this.scope, key)
  }

  set<T>(key: string, value: T): Promise<void> {
    return this.storage.checkpoints.set(this.scope, key, value)
  }

  clear(key: string): Promise<void> {
    return this.storage.checkpoints.clear(this.scope, key)
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function toPortablePath(value: string): string {
  return value.split(sep).join('/')
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_') || 'unknown'
}

function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function safePortableRelative(value: string): string {
  if (!value || value.includes('\u0000')) throw new Error('Unsafe backup relative path')
  const normalized = posix.normalize(value.replaceAll('\\', '/'))
  if (normalized === '.' || posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Unsafe backup relative path: ${value}`)
  }
  return normalized
}

function safeSnapshotId(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error('Unsafe backup snapshot id')
  return value
}

function assetKind(type: string): BackupAssetKind {
  if (type === 'skill' || type === 'mcp' || type === 'plugin' || type === 'extension'
    || type === 'hook' || type === 'memory' || type === 'rule') return type
  if (type === 'builtin') return 'config'
  return 'other'
}

function selectedKind(kinds: Iterable<BackupAssetKind>, input: BackupCreateInput): boolean {
  if (!input.kinds?.length) return true
  const available = new Set(kinds)
  return input.kinds.some(kind => available.has(kind))
}

function selectedSource(sourceId: string, input: BackupCreateInput): boolean {
  return !input.sourceIds?.length || input.sourceIds.includes(sourceId)
}

function sourceScope(
  detected: DetectedSource,
  path: string,
): { scope: BackupSourceScope; rootPath: string } | null {
  if (detected.dataRoot && isInside(detected.dataRoot, path)) {
    return { scope: 'data', rootPath: detected.dataRoot }
  }
  if (detected.configRoot && isInside(detected.configRoot, path)) {
    return { scope: 'config', rootPath: detected.configRoot }
  }
  return null
}

function exclusion(
  target: BackupTarget,
  originalPath: string,
  kinds: Iterable<BackupAssetKind>,
  reason: BackupExcludedEntry['reason'],
): BackupExcludedEntry {
  return {
    sourceId: target.source.manifest.sourceId,
    productId: target.detected.productId,
    installationId: target.installation.id,
    originalPath,
    kinds: [...new Set(kinds)].sort(),
    reason,
  }
}

function indexedExclusion(
  file: BackupIndexedFile,
  reason: BackupExcludedEntry['reason'],
): BackupExcludedEntry {
  return {
    sourceId: file.sourceId,
    productId: file.productId,
    installationId: file.installationId,
    originalPath: file.originalPath,
    kinds: [...file.kinds].sort(),
    reason,
  }
}

function inventoryFileKey(file: Pick<BackupIndexedFile, 'sourceId' | 'installationId' | 'originalPath'>): string {
  return `${file.sourceId}\u0000${file.installationId}\u0000${resolve(file.originalPath)}`
}

function manifestPayload(manifest: Omit<BackupSnapshotManifest, 'manifestSha256'>): string {
  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    createdAt: manifest.createdAt,
    files: manifest.files,
    excluded: manifest.excluded,
  })
}

function summarize(manifest: BackupSnapshotManifest): BackupSnapshotSummary {
  const sourceIds = new Set<string>()
  let totalBytes = 0
  for (const file of manifest.files) {
    sourceIds.add(file.sourceId)
    totalBytes += file.size
  }
  for (const item of manifest.excluded) sourceIds.add(item.sourceId)
  return {
    id: manifest.id,
    createdAt: manifest.createdAt,
    sourceIds: [...sourceIds].sort(),
    fileCount: manifest.files.length,
    excludedCount: manifest.excluded.length,
    totalBytes,
    manifestSha256: manifest.manifestSha256,
  }
}

async function pathState(path: string): Promise<'file' | 'directory' | 'symlink' | 'missing' | 'other'> {
  try {
    const meta = await lstat(path)
    if (meta.isSymbolicLink()) return 'symlink'
    if (meta.isFile()) return 'file'
    if (meta.isDirectory()) return 'directory'
    return 'other'
  } catch {
    return 'missing'
  }
}

async function* walkFiles(root: string): AsyncIterable<{ path: string; symlink: boolean }> {
  const state = await pathState(root)
  if (state === 'file') {
    yield { path: root, symlink: false }
    return
  }
  if (state === 'symlink') {
    yield { path: root, symlink: true }
    return
  }
  if (state !== 'directory') return

  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) yield { path, symlink: true }
    else if (entry.isFile()) yield { path, symlink: false }
    else if (entry.isDirectory()) yield* walkFiles(path)
  }
}

function sensitiveReason(path: string, kinds: Set<BackupAssetKind>, bytes: Uint8Array): BackupExcludedEntry['reason'] | null {
  if (SENSITIVE_FILE_NAME.test(basename(path))) return 'sensitive-file-name'
  const sample = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 512 * 1024))
  if (sample.includes(0)) return null
  const text = sample.toString('utf8')
  if (HIGH_CONFIDENCE_SECRET.test(text)) return 'sensitive-content'
  if ([...kinds].some(kind => kind === 'config' || kind === 'mcp' || kind === 'hook')
    && CONFIG_SECRET_ASSIGNMENT.test(text)) return 'sensitive-content'
  return null
}

function parseManifest(value: unknown): BackupSnapshotManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid backup manifest')
  const manifest = value as Partial<BackupSnapshotManifest>
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION
    || typeof manifest.id !== 'string'
    || typeof manifest.createdAt !== 'string'
    || typeof manifest.manifestSha256 !== 'string'
    || !Array.isArray(manifest.files)
    || !Array.isArray(manifest.excluded)) throw new Error('Invalid backup manifest')
  safeSnapshotId(manifest.id)
  for (const file of manifest.files) {
    if (!file || typeof file !== 'object'
      || typeof file.archivePath !== 'string'
      || typeof file.sourceRelativePath !== 'string'
      || typeof file.sourceId !== 'string'
      || typeof file.productId !== 'string'
      || typeof file.installationId !== 'string'
      || (file.sourceScope !== 'config' && file.sourceScope !== 'data')
      || typeof file.originalPath !== 'string'
      || !Array.isArray(file.kinds)
      || typeof file.size !== 'number'
      || typeof file.sha256 !== 'string') throw new Error('Invalid backup manifest file entry')
    safePortableRelative(file.archivePath)
    safePortableRelative(file.sourceRelativePath)
  }
  const typed = manifest as BackupSnapshotManifest
  const expected = sha256(manifestPayload({
    schemaVersion: typed.schemaVersion,
    id: typed.id,
    createdAt: typed.createdAt,
    files: typed.files,
    excluded: typed.excluded,
  }))
  if (expected !== typed.manifestSha256) throw new Error('Backup manifest hash mismatch')
  return typed
}

function parseInventory(value: unknown): BackupInventory | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const inventory = value as Partial<BackupInventory>
  if (inventory.version !== INVENTORY_VERSION
    || typeof inventory.generatedAt !== 'string'
    || !Array.isArray(inventory.sources)
    || !Array.isArray(inventory.files)
    || !Array.isArray(inventory.excluded)) return null
  for (const file of inventory.files) {
    if (!file || typeof file !== 'object'
      || typeof file.sourceId !== 'string'
      || typeof file.productId !== 'string'
      || typeof file.installationId !== 'string'
      || typeof file.originalPath !== 'string'
      || (file.sourceScope !== 'config' && file.sourceScope !== 'data')
      || typeof file.sourceRelativePath !== 'string'
      || typeof file.archivePath !== 'string'
      || !Array.isArray(file.kinds)
      || typeof file.size !== 'number'
      || typeof file.mtimeMs !== 'number'
      || typeof file.ctimeMs !== 'number'
      || (file.sha256 !== undefined && typeof file.sha256 !== 'string')) return null
    try {
      safePortableRelative(file.archivePath)
      safePortableRelative(file.sourceRelativePath)
    } catch {
      return null
    }
  }
  return inventory as BackupInventory
}

export interface LocalBackupServiceOptions {
  vaultPath: string
}

export class LocalBackupService implements BackupService {
  private readonly snapshotsPath: string
  private readonly blobsPath: string
  private readonly inventoryPath: string
  private inventory: BackupInventory | null = null
  private inventoryLoadInFlight: Promise<BackupInventory> | null = null
  private refreshInFlight: Promise<BackupInventory> | null = null
  private refreshTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly storage: StorageService,
    private readonly sources: SourceService,
    private readonly identity: IdentityService,
    private readonly options: LocalBackupServiceOptions,
  ) {
    this.snapshotsPath = join(options.vaultPath, 'snapshots')
    this.blobsPath = join(options.vaultPath, 'blobs')
    this.inventoryPath = join(options.vaultPath, 'inventory-v1.json')
  }

  start(): void {
    void this.ensureInventory()
      .then(inventory => {
        const age = Date.now() - Date.parse(inventory.generatedAt)
        if (!Number.isFinite(age) || age >= INDEX_STARTUP_STALE_MS) {
          return this.rebuildInventory()
        }
        return inventory
      })
      .catch(() => {})
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => {
        void this.rebuildInventory().catch(() => {})
      }, INDEX_REFRESH_INTERVAL_MS)
      this.refreshTimer.unref()
    }
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.refreshTimer = null
  }

  private async targets(input: BackupCreateInput = {}): Promise<BackupTarget[]> {
    const host = await this.identity.resolveHost({
      name: hostname(),
      platform: platform(),
      arch: arch(),
    })
    const selected = new Set(input.sourceIds ?? [])
    const targets: BackupTarget[] = []
    for (const source of this.sources.list()) {
      if (selected.size && !selected.has(source.manifest.sourceId)) continue
      let detected: DetectedSource[] = []
      try {
        detected = await source.detect({ host, env: process.env })
      } catch {
        continue
      }
      for (const item of detected) {
        const installation = await this.identity.resolveInstallation({
          hostId: host.id,
          productId: item.productId,
          ...(item.executable ? { executable: item.executable } : {}),
          ...(item.version ? { version: item.version } : {}),
          ...(item.configRoot ? { configRoot: item.configRoot } : {}),
          ...(item.dataRoot ? { dataRoot: item.dataRoot } : {}),
        })
        targets.push({ source, detected: item, host, installation })
      }
    }
    return targets
  }

  private async rootsForTarget(target: BackupTarget): Promise<{ roots: CandidateRoot[]; excluded: BackupExcludedEntry[] }> {
    const roots = new Map<string, CandidateRoot>()
    const excluded: BackupExcludedEntry[] = []
    const addRoot = (path: string, kinds: BackupAssetKind[], preferredScope?: BackupSourceScope) => {
      const scoped = preferredScope
        ? { scope: preferredScope, rootPath: preferredScope === 'data' ? target.detected.dataRoot : target.detected.configRoot }
        : sourceScope(target.detected, path)
      if (!scoped?.rootPath || !isInside(scoped.rootPath, path)) {
        excluded.push(exclusion(target, path, kinds, 'outside-source-roots'))
        return
      }
      const key = resolve(path)
      const existing = roots.get(key)
      if (existing) {
        for (const kind of kinds) existing.kinds.add(kind)
      } else {
        roots.set(key, {
          target,
          path,
          scope: scoped.scope,
          rootPath: scoped.rootPath,
          kinds: new Set(kinds),
        })
      }
    }

    if (target.detected.dataRoot) addRoot(target.detected.dataRoot, ['session'], 'data')
    if (target.source.discoverAssets) {
      const checkpoint = new ScopedCheckpointService(
        this.storage,
        `backup:${target.source.manifest.sourceId}:${target.installation.id}`,
      )
      try {
        for await (const asset of target.source.discoverAssets({
          host: target.host,
          installation: target.installation,
          abortSignal: new AbortController().signal,
          checkpoint,
        })) {
          if (asset.binding?.path) addRoot(asset.binding.path, [assetKind(asset.definition.type)])
        }
      } catch {
        // A broken static discovery source must not prevent raw Session protection.
      }
    }
    return { roots: [...roots.values()], excluded }
  }

  private async plan(): Promise<BackupPlan> {
    const targets = await this.targets()
    const files = new Map<string, CandidateFile>()
    const excluded: BackupExcludedEntry[] = []

    for (const target of targets) {
      const roots = await this.rootsForTarget(target)
      excluded.push(...roots.excluded)
      for (const root of roots.roots) {
        const rootState = await pathState(root.path)
        if (rootState === 'symlink') {
          excluded.push(exclusion(target, root.path, root.kinds, 'symbolic-link'))
          continue
        }
        for await (const item of walkFiles(root.path)) {
          if (item.symlink) {
            excluded.push(exclusion(target, item.path, root.kinds, 'symbolic-link'))
            continue
          }
          const relativePath = relative(root.rootPath, item.path)
          if (!relativePath || isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
            excluded.push(exclusion(target, item.path, root.kinds, 'outside-source-roots'))
            continue
          }
          let meta
          try {
            meta = await lstat(item.path)
            if (!meta.isFile()) continue
          } catch {
            excluded.push(exclusion(target, item.path, root.kinds, 'unreadable'))
            continue
          }
          const sourceRelativePath = safePortableRelative(toPortablePath(relativePath))
          const archivePath = safePortableRelative([
            safeSegment(target.source.manifest.sourceId),
            safeSegment(target.installation.id),
            root.scope,
            sourceRelativePath,
          ].join('/'))
          const key = `${target.source.manifest.sourceId}\u0000${target.installation.id}\u0000${resolve(item.path)}`
          const existing = files.get(key)
          if (existing) {
            for (const kind of root.kinds) existing.kinds.add(kind)
          } else {
            files.set(key, {
              sourceId: target.source.manifest.sourceId,
              productId: target.detected.productId,
              installationId: target.installation.id,
              path: item.path,
              scope: root.scope,
              sourceRelativePath,
              archivePath,
              kinds: new Set(root.kinds),
              size: meta.size,
              mtimeMs: meta.mtimeMs,
              ctimeMs: meta.ctimeMs,
            })
          }
        }
      }
    }

    return {
      files: [...files.values()].sort((a, b) => a.archivePath.localeCompare(b.archivePath)),
      excluded,
      targets,
    }
  }

  private protectionSources(plan: BackupPlan): BackupProtectionSource[] {
    const bySource = new Map<string, BackupProtectionSource>()
    for (const source of this.sources.list()) {
      bySource.set(source.manifest.sourceId, {
        sourceId: source.manifest.sourceId,
        productId: source.manifest.productId,
        displayName: source.manifest.displayName,
        detected: false,
        fileCount: 0,
        excludedCount: 0,
        kinds: {},
      })
    }
    for (const target of plan.targets) {
      const item = bySource.get(target.source.manifest.sourceId)
      if (item) item.detected = true
    }
    for (const file of plan.files) {
      const item = bySource.get(file.sourceId)
      if (!item) continue
      item.fileCount += 1
      for (const kind of file.kinds) item.kinds[kind] = (item.kinds[kind] ?? 0) + 1
    }
    for (const excluded of plan.excluded) {
      const item = bySource.get(excluded.sourceId)
      if (item) item.excludedCount += 1
    }
    return [...bySource.values()].sort((a, b) => a.displayName.localeCompare(b.displayName))
  }

  private inventoryFromPlan(plan: BackupPlan): BackupInventory {
    const previous = new Map(
      (this.inventory?.files ?? []).map(file => [inventoryFileKey(file), file]),
    )
    const files: BackupIndexedFile[] = plan.files.map(file => {
      const indexed: BackupIndexedFile = {
        sourceId: file.sourceId,
        productId: file.productId,
        installationId: file.installationId,
        originalPath: file.path,
        sourceScope: file.scope,
        sourceRelativePath: file.sourceRelativePath,
        archivePath: file.archivePath,
        kinds: [...file.kinds].sort(),
        size: file.size,
        mtimeMs: file.mtimeMs,
        ctimeMs: file.ctimeMs,
      }
      const old = previous.get(inventoryFileKey(indexed))
      if (old?.sha256
        && old.size === indexed.size
        && old.mtimeMs === indexed.mtimeMs
        && old.ctimeMs === indexed.ctimeMs) {
        indexed.sha256 = old.sha256
      }
      return indexed
    })
    return {
      version: INVENTORY_VERSION,
      generatedAt: new Date().toISOString(),
      sources: this.protectionSources(plan),
      files,
      excluded: [...plan.excluded].sort(
        (a, b) => a.sourceId.localeCompare(b.sourceId) || a.originalPath.localeCompare(b.originalPath),
      ),
    }
  }

  private async readInventory(): Promise<BackupInventory | null> {
    try {
      return parseInventory(JSON.parse(await readFile(this.inventoryPath, 'utf8')))
    } catch {
      return null
    }
  }

  private async writeInventory(inventory: BackupInventory): Promise<void> {
    await mkdir(this.options.vaultPath, { recursive: true })
    const stage = `${this.inventoryPath}.${randomUUID().slice(0, 8)}.tmp`
    await writeFile(stage, `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx' })
    try {
      await rename(stage, this.inventoryPath)
    } catch (error) {
      await rm(stage, { force: true })
      throw error
    }
    this.inventory = inventory
  }

  private async ensureInventory(): Promise<BackupInventory> {
    if (this.inventory) return this.inventory
    if (this.inventoryLoadInFlight) return this.inventoryLoadInFlight
    const promise = (async () => {
      const stored = await this.readInventory()
      if (stored) {
        this.inventory = stored
        return stored
      }
      return this.rebuildInventory()
    })()
    this.inventoryLoadInFlight = promise
    try {
      return await promise
    } finally {
      if (this.inventoryLoadInFlight === promise) this.inventoryLoadInFlight = null
    }
  }

  private async rebuildInventory(): Promise<BackupInventory> {
    if (this.refreshInFlight) return this.refreshInFlight
    const promise = (async () => {
      const plan = await this.plan()
      const inventory = this.inventoryFromPlan(plan)
      await this.writeInventory(inventory)
      return inventory
    })()
    this.refreshInFlight = promise
    try {
      return await promise
    } finally {
      if (this.refreshInFlight === promise) this.refreshInFlight = null
    }
  }

  private filteredSources(inventory: BackupInventory, input: BackupCreateInput): BackupProtectionSource[] {
    const bySource = new Map<string, BackupProtectionSource>()
    for (const source of inventory.sources) {
      if (!selectedSource(source.sourceId, input)) continue
      bySource.set(source.sourceId, {
        sourceId: source.sourceId,
        productId: source.productId,
        displayName: source.displayName,
        detected: source.detected,
        fileCount: 0,
        excludedCount: 0,
        kinds: {},
      })
    }
    for (const file of inventory.files) {
      if (!selectedSource(file.sourceId, input) || !selectedKind(file.kinds, input)) continue
      const source = bySource.get(file.sourceId)
      if (!source) continue
      source.fileCount += 1
      for (const kind of file.kinds) {
        if (input.kinds?.length && !input.kinds.includes(kind)) continue
        source.kinds[kind] = (source.kinds[kind] ?? 0) + 1
      }
    }
    for (const excluded of inventory.excluded) {
      if (!selectedSource(excluded.sourceId, input) || !selectedKind(excluded.kinds, input)) continue
      const source = bySource.get(excluded.sourceId)
      if (source) source.excludedCount += 1
    }
    return [...bySource.values()].sort((a, b) => a.displayName.localeCompare(b.displayName))
  }

  private async overviewFromInventory(inventory: BackupInventory, input: BackupCreateInput = {}): Promise<BackupOverview> {
    return {
      vaultPath: this.options.vaultPath,
      sources: this.filteredSources(inventory, input),
      snapshots: await this.listSnapshots(),
      index: {
        generatedAt: inventory.generatedAt,
        refreshing: Boolean(this.refreshInFlight),
      },
    }
  }

  async overview(input: BackupCreateInput = {}): Promise<BackupOverview> {
    return this.overviewFromInventory(await this.ensureInventory(), input)
  }

  async refreshIndex(input: BackupCreateInput = {}): Promise<BackupOverview> {
    return this.overviewFromInventory(await this.rebuildInventory(), input)
  }

  async listSnapshots(): Promise<BackupSnapshotSummary[]> {
    await mkdir(this.snapshotsPath, { recursive: true })
    const entries = await readdir(this.snapshotsPath, { withFileTypes: true })
    const summaries: BackupSnapshotSummary[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.endsWith('.tmp')) continue
      try {
        const manifest = await this.getSnapshot(entry.name)
        if (manifest) summaries.push(summarize(manifest))
      } catch {
        // Corrupt directories are not presented as valid snapshots.
      }
    }
    return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async getSnapshot(id: string): Promise<BackupSnapshotManifest | null> {
    safeSnapshotId(id)
    try {
      const raw = JSON.parse(await readFile(join(this.snapshotsPath, id, 'manifest.json'), 'utf8'))
      return parseManifest(raw)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw error
    }
  }

  private blobPath(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid backup blob hash')
    return join(this.blobsPath, hash.slice(0, 2), hash)
  }

  private async blobReusable(hash: string, size: number): Promise<boolean> {
    try {
      const meta = await lstat(this.blobPath(hash))
      return meta.isFile() && meta.size === size
    } catch {
      return false
    }
  }

  private async storeBlob(hash: string, bytes: Buffer): Promise<void> {
    const path = this.blobPath(hash)
    await mkdir(join(path, '..'), { recursive: true })
    try {
      await writeFile(path, bytes, { flag: 'wx' })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
    }
    const existing = await readFile(path)
    if (existing.byteLength !== bytes.byteLength || sha256(existing) !== hash) {
      throw new Error(`备份内容库存在损坏或 Hash 冲突：${hash}`)
    }
  }

  private async readSnapshotFile(id: string, file: BackupManifestFile): Promise<Buffer> {
    try {
      return await readFile(this.blobPath(file.sha256))
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
    return readFile(join(this.snapshotsPath, id, 'files', ...safePortableRelative(file.archivePath).split('/')))
  }

  private async applyHashUpdates(updates: Map<string, HashUpdate>): Promise<void> {
    if (!updates.size) return
    const inventory = await this.ensureInventory()
    let changed = false
    for (const file of inventory.files) {
      const update = updates.get(inventoryFileKey(file))
      if (!update) continue
      if (file.size !== update.size || file.mtimeMs !== update.mtimeMs || file.ctimeMs !== update.ctimeMs) continue
      if (file.sha256 === update.sha256) continue
      file.sha256 = update.sha256
      changed = true
    }
    if (changed) await this.writeInventory(inventory)
  }

  async createSnapshot(input: BackupCreateInput = {}): Promise<BackupSnapshotManifest> {
    const inventory = await this.ensureInventory()
    const files = inventory.files.filter(file => selectedSource(file.sourceId, input) && selectedKind(file.kinds, input))
    const excluded = inventory.excluded
      .filter(item => selectedSource(item.sourceId, input) && selectedKind(item.kinds, input))
      .map(item => ({ ...item, kinds: [...item.kinds] }))
    if (!files.length && !excluded.length) throw new Error('没有发现可备份的源文件')

    await mkdir(this.snapshotsPath, { recursive: true })
    await mkdir(this.blobsPath, { recursive: true })
    const createdAt = new Date().toISOString()
    const id = `${createdAt.replace(/[-:.]/g, '').replace('Z', 'Z')}-${randomUUID().slice(0, 8)}`
    const stagePath = join(this.snapshotsPath, `${id}.tmp`)
    const finalPath = join(this.snapshotsPath, id)
    const manifestFiles: BackupManifestFile[] = []
    const hashUpdates = new Map<string, HashUpdate>()

    await rm(stagePath, { recursive: true, force: true })
    await mkdir(stagePath, { recursive: true })
    try {
      for (const candidate of files) {
        let meta
        try {
          meta = await lstat(candidate.originalPath)
        } catch {
          excluded.push(indexedExclusion(candidate, 'unreadable'))
          continue
        }
        if (meta.isSymbolicLink()) {
          excluded.push(indexedExclusion(candidate, 'symbolic-link'))
          continue
        }
        if (!meta.isFile()) {
          excluded.push(indexedExclusion(candidate, 'unreadable'))
          continue
        }

        const metadataMatches = candidate.size === meta.size
          && candidate.mtimeMs === meta.mtimeMs
          && candidate.ctimeMs === meta.ctimeMs
        if (metadataMatches && candidate.sha256 && await this.blobReusable(candidate.sha256, candidate.size)) {
          manifestFiles.push({
            sourceId: candidate.sourceId,
            productId: candidate.productId,
            installationId: candidate.installationId,
            sourceScope: candidate.sourceScope,
            sourceRelativePath: candidate.sourceRelativePath,
            originalPath: candidate.originalPath,
            archivePath: candidate.archivePath,
            kinds: [...candidate.kinds],
            size: candidate.size,
            sha256: candidate.sha256,
          })
          continue
        }

        let bytes: Buffer
        try {
          bytes = await readFile(candidate.originalPath)
        } catch {
          excluded.push(indexedExclusion(candidate, 'unreadable'))
          continue
        }
        const kinds = new Set(candidate.kinds)
        const reason = sensitiveReason(candidate.originalPath, kinds, bytes)
        if (reason) {
          excluded.push(indexedExclusion(candidate, reason))
          continue
        }
        const hash = sha256(bytes)
        await this.storeBlob(hash, bytes)
        manifestFiles.push({
          sourceId: candidate.sourceId,
          productId: candidate.productId,
          installationId: candidate.installationId,
          sourceScope: candidate.sourceScope,
          sourceRelativePath: candidate.sourceRelativePath,
          originalPath: candidate.originalPath,
          archivePath: candidate.archivePath,
          kinds: [...candidate.kinds],
          size: bytes.byteLength,
          sha256: hash,
        })
        hashUpdates.set(inventoryFileKey(candidate), {
          size: meta.size,
          mtimeMs: meta.mtimeMs,
          ctimeMs: meta.ctimeMs,
          sha256: hash,
        })
      }

      manifestFiles.sort((a, b) => a.archivePath.localeCompare(b.archivePath))
      excluded.sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.originalPath.localeCompare(b.originalPath))
      const base: Omit<BackupSnapshotManifest, 'manifestSha256'> = {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        id,
        createdAt,
        files: manifestFiles,
        excluded,
      }
      const manifest: BackupSnapshotManifest = {
        ...base,
        manifestSha256: sha256(manifestPayload(base)),
      }
      await writeFile(join(stagePath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
      await rename(stagePath, finalPath)
      await this.applyHashUpdates(hashUpdates)
      return manifest
    } catch (error) {
      await rm(stagePath, { recursive: true, force: true })
      throw error
    }
  }

  async verifySnapshot(id: string): Promise<BackupVerifyResult> {
    const manifest = await this.getSnapshot(id)
    if (!manifest) throw new Error(`找不到快照：${id}`)
    const missingFiles: string[] = []
    const mismatchedFiles: string[] = []
    let checkedFiles = 0
    for (const file of manifest.files) {
      try {
        const bytes = await this.readSnapshotFile(id, file)
        checkedFiles += 1
        if (bytes.byteLength !== file.size || sha256(bytes) !== file.sha256) mismatchedFiles.push(file.archivePath)
      } catch {
        missingFiles.push(file.archivePath)
      }
    }
    const base: Omit<BackupSnapshotManifest, 'manifestSha256'> = {
      schemaVersion: manifest.schemaVersion,
      id: manifest.id,
      createdAt: manifest.createdAt,
      files: manifest.files,
      excluded: manifest.excluded,
    }
    const manifestMatches = sha256(manifestPayload(base)) === manifest.manifestSha256
    return {
      snapshotId: id,
      valid: manifestMatches && !missingFiles.length && !mismatchedFiles.length,
      manifestMatches,
      checkedFiles,
      missingFiles,
      mismatchedFiles,
    }
  }

  async exportSnapshot(id: string): Promise<Uint8Array> {
    const manifest = await this.getSnapshot(id)
    if (!manifest) throw new Error(`找不到快照：${id}`)
    const verified = await this.verifySnapshot(id)
    if (!verified.valid) throw new Error('快照完整性校验失败，拒绝导出')
    const files: BackupBundleFile[] = []
    for (const file of manifest.files) {
      const bytes = await this.readSnapshotFile(id, file)
      files.push({ archivePath: file.archivePath, dataBase64: bytes.toString('base64') })
    }
    const bundle: BackupBundle = { bundleVersion: BUNDLE_VERSION, manifest, files }
    return gzipSync(Buffer.from(JSON.stringify(bundle)))
  }

  async importSnapshot(bundleBytes: Uint8Array): Promise<BackupSnapshotManifest> {
    if (bundleBytes.byteLength > MAX_IMPORT_BYTES) throw new Error('备份包过大，拒绝导入')
    let decoded: Buffer
    try {
      decoded = gunzipSync(Buffer.from(bundleBytes), { maxOutputLength: MAX_BUNDLE_JSON_BYTES })
    } catch {
      throw new Error('备份包不是有效的 AgentLens 压缩包')
    }
    let raw: unknown
    try {
      raw = JSON.parse(decoded.toString('utf8'))
    } catch {
      throw new Error('备份包内容不是有效 JSON')
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('备份包结构无效')
    const bundle = raw as Partial<BackupBundle>
    if (bundle.bundleVersion !== BUNDLE_VERSION || !Array.isArray(bundle.files)) throw new Error('不支持的备份包版本')
    const manifest = parseManifest(bundle.manifest)
    const fileMap = new Map<string, Buffer>()
    for (const item of bundle.files) {
      if (!item || typeof item.archivePath !== 'string' || typeof item.dataBase64 !== 'string') throw new Error('备份包文件条目无效')
      const archivePath = safePortableRelative(item.archivePath)
      if (fileMap.has(archivePath)) throw new Error(`备份包包含重复文件：${archivePath}`)
      fileMap.set(archivePath, Buffer.from(item.dataBase64, 'base64'))
    }
    if (fileMap.size !== manifest.files.length) throw new Error('备份包文件数量与 Manifest 不一致')
    for (const file of manifest.files) {
      const bytes = fileMap.get(file.archivePath)
      if (!bytes || bytes.byteLength !== file.size || sha256(bytes) !== file.sha256) {
        throw new Error(`备份包文件校验失败：${file.archivePath}`)
      }
    }

    await mkdir(this.snapshotsPath, { recursive: true })
    await mkdir(this.blobsPath, { recursive: true })
    const existing = await this.getSnapshot(manifest.id)
    if (existing) {
      if (existing.manifestSha256 === manifest.manifestSha256) return existing
      throw new Error(`本地已存在同名但内容不同的快照：${manifest.id}`)
    }
    const stagePath = join(this.snapshotsPath, `${manifest.id}.tmp`)
    const finalPath = join(this.snapshotsPath, manifest.id)
    await rm(stagePath, { recursive: true, force: true })
    await mkdir(stagePath, { recursive: true })
    try {
      for (const file of manifest.files) {
        await this.storeBlob(file.sha256, fileMap.get(file.archivePath)!)
      }
      await writeFile(join(stagePath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
      await rename(stagePath, finalPath)
      return manifest
    } catch (error) {
      await rm(stagePath, { recursive: true, force: true })
      throw error
    }
  }

  async previewRestore(id: string): Promise<BackupRestorePreview> {
    const manifest = await this.getSnapshot(id)
    if (!manifest) throw new Error(`找不到快照：${id}`)
    const targets = await this.targets({ sourceIds: [...new Set(manifest.files.map(file => file.sourceId))] })
    const bySource = new Map<string, BackupTarget>()
    for (const target of targets) {
      if (!bySource.has(target.source.manifest.sourceId)) bySource.set(target.source.manifest.sourceId, target)
    }
    const items: BackupRestorePreviewEntry[] = []

    for (const file of manifest.files) {
      const target = bySource.get(file.sourceId)
      const root = file.sourceScope === 'data' ? target?.detected.dataRoot : target?.detected.configRoot
      if (!target || !root) {
        items.push({ sourceId: file.sourceId, archivePath: file.archivePath, kinds: file.kinds, status: 'blocked', reason: '当前未检测到对应智能体或恢复根目录' })
        continue
      }
      let sourceRelativePath: string
      try {
        sourceRelativePath = safePortableRelative(file.sourceRelativePath)
      } catch {
        items.push({ sourceId: file.sourceId, archivePath: file.archivePath, kinds: file.kinds, status: 'blocked', reason: '快照包含不安全的相对路径' })
        continue
      }
      const targetPath = resolve(root, ...sourceRelativePath.split('/'))
      if (!isInside(root, targetPath)) {
        items.push({ sourceId: file.sourceId, archivePath: file.archivePath, kinds: file.kinds, status: 'blocked', reason: '恢复目标超出智能体数据目录' })
        continue
      }
      const state = await pathState(targetPath)
      if (state === 'missing') {
        items.push({ sourceId: file.sourceId, archivePath: file.archivePath, targetPath, kinds: file.kinds, status: 'missing' })
        continue
      }
      if (state !== 'file') {
        items.push({ sourceId: file.sourceId, archivePath: file.archivePath, targetPath, kinds: file.kinds, status: 'blocked', reason: state === 'symlink' ? '目标是符号链接' : '目标不是普通文件' })
        continue
      }
      try {
        const current = await readFile(targetPath)
        items.push({
          sourceId: file.sourceId,
          archivePath: file.archivePath,
          targetPath,
          kinds: file.kinds,
          status: current.byteLength === file.size && sha256(current) === file.sha256 ? 'unchanged' : 'modified',
        })
      } catch {
        items.push({ sourceId: file.sourceId, archivePath: file.archivePath, targetPath, kinds: file.kinds, status: 'blocked', reason: '无法读取当前目标文件' })
      }
    }

    return {
      snapshotId: id,
      generatedAt: new Date().toISOString(),
      items,
      unchanged: items.filter(item => item.status === 'unchanged').length,
      missing: items.filter(item => item.status === 'missing').length,
      modified: items.filter(item => item.status === 'modified').length,
      blocked: items.filter(item => item.status === 'blocked').length,
    }
  }
}

export const backupLocalInternals = {
  assetKind,
  isInside,
  safePortableRelative,
  sensitiveReason,
  manifestPayload,
  parseManifest,
  parseInventory,
}
