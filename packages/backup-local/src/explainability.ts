import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type {
  BackupAssetKind,
  BackupCreateInput,
  BackupOverview,
  BackupProtectionSource,
  BackupService,
  BackupSnapshotManifest,
  BackupSnapshotSummary,
  BackupRestorePreview,
  BackupVerifyResult,
} from '@agent-lens/core'

interface IndexedFile {
  sourceId: string
  originalPath: string
  sourceScope: 'config' | 'data'
  sourceRelativePath: string
  kinds: BackupAssetKind[]
  size: number
  mtimeMs: number
}

interface InventoryFile {
  version: 1
  files: IndexedFile[]
}

function selectedSource(sourceId: string, input: BackupCreateInput): boolean {
  return !input.sourceIds?.length || input.sourceIds.includes(sourceId)
}

function selectedKind(kinds: BackupAssetKind[], input: BackupCreateInput): boolean {
  return !input.kinds?.length || input.kinds.some(kind => kinds.includes(kind))
}

function sourceRoot(file: IndexedFile): string {
  let root = resolve(file.originalPath)
  const segments = file.sourceRelativePath.split('/').filter(Boolean)
  for (let index = 0; index < segments.length; index += 1) root = dirname(root)
  return root
}

async function readInventory(path: string): Promise<InventoryFile | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<InventoryFile>
    if (value.version !== 1 || !Array.isArray(value.files)) return null
    return value as InventoryFile
  } catch {
    return null
  }
}

function emptyAgeBuckets() {
  return {
    recent30Days: { fileCount: 0, totalBytes: 0 },
    days31To90: { fileCount: 0, totalBytes: 0 },
    days91To180: { fileCount: 0, totalBytes: 0 },
    olderThan180Days: { fileCount: 0, totalBytes: 0 },
  }
}

function enrichSource(source: BackupProtectionSource, files: IndexedFile[]): BackupProtectionSource {
  if (!files.length) return source

  const kindDetails: NonNullable<BackupProtectionSource['kindDetails']> = {}
  const roots = new Map<string, { scope: 'config' | 'data'; path: string; fileCount: number; totalBytes: number }>()
  const ageBuckets = emptyAgeBuckets()
  const now = Date.now()
  let totalBytes = 0
  let oldest = Number.POSITIVE_INFINITY
  let latest = 0

  for (const file of files) {
    totalBytes += file.size
    oldest = Math.min(oldest, file.mtimeMs)
    latest = Math.max(latest, file.mtimeMs)

    for (const kind of file.kinds) {
      const detail = kindDetails[kind] ?? { fileCount: 0, totalBytes: 0 }
      detail.fileCount += 1
      detail.totalBytes = (detail.totalBytes ?? 0) + file.size
      kindDetails[kind] = detail
    }

    const rootPath = sourceRoot(file)
    const rootKey = `${file.sourceScope}\u0000${rootPath}`
    const root = roots.get(rootKey) ?? { scope: file.sourceScope, path: rootPath, fileCount: 0, totalBytes: 0 }
    root.fileCount += 1
    root.totalBytes += file.size
    roots.set(rootKey, root)

    const ageDays = Math.max(0, now - file.mtimeMs) / 86_400_000
    const bucket = ageDays <= 30
      ? ageBuckets.recent30Days
      : ageDays <= 90
        ? ageBuckets.days31To90
        : ageDays <= 180
          ? ageBuckets.days91To180
          : ageBuckets.olderThan180Days
    bucket.fileCount += 1
    bucket.totalBytes = (bucket.totalBytes ?? 0) + file.size
  }

  const oldestModifiedAt = Number.isFinite(oldest) ? new Date(oldest).toISOString() : undefined
  const latestModifiedAt = latest > 0 ? new Date(latest).toISOString() : undefined
  return {
    ...source,
    totalBytes,
    kindDetails,
    roots: [...roots.values()].sort((a, b) => a.scope.localeCompare(b.scope) || a.path.localeCompare(b.path)),
    ...(oldestModifiedAt ? { oldestModifiedAt } : {}),
    ...(latestModifiedAt ? { latestModifiedAt } : {}),
    ageBuckets,
  }
}

function enrichOverview(overview: BackupOverview, inventory: InventoryFile | null, input: BackupCreateInput): BackupOverview {
  if (!inventory) return overview
  const bySource = new Map<string, IndexedFile[]>()
  for (const file of inventory.files) {
    if (!selectedSource(file.sourceId, input) || !selectedKind(file.kinds, input)) continue
    const files = bySource.get(file.sourceId) ?? []
    files.push(file)
    bySource.set(file.sourceId, files)
  }
  return {
    ...overview,
    sources: overview.sources.map(source => enrichSource(source, bySource.get(source.sourceId) ?? [])),
  }
}

/**
 * 只从已有 inventory-v1.json 汇总解释性统计，不重新遍历第三方数据目录。
 * 逻辑资产数量只有 Source 能可靠提供时才展示；这里绝不从文件数反推。
 */
export class ExplainableBackupService implements BackupService {
  constructor(
    private readonly base: BackupService,
    private readonly inventoryPath: string,
  ) {}

  async overview(input: BackupCreateInput = {}): Promise<BackupOverview> {
    const overview = await this.base.overview(input)
    return enrichOverview(overview, await readInventory(this.inventoryPath), input)
  }

  async refreshIndex(input: BackupCreateInput = {}): Promise<BackupOverview> {
    const overview = this.base.refreshIndex
      ? await this.base.refreshIndex(input)
      : await this.base.overview(input)
    return enrichOverview(overview, await readInventory(this.inventoryPath), input)
  }

  listSnapshots(): Promise<BackupSnapshotSummary[]> { return this.base.listSnapshots() }
  getSnapshot(id: string): Promise<BackupSnapshotManifest | null> { return this.base.getSnapshot(id) }
  createSnapshot(input: BackupCreateInput = {}): Promise<BackupSnapshotManifest> { return this.base.createSnapshot(input) }
  verifySnapshot(id: string): Promise<BackupVerifyResult> { return this.base.verifySnapshot(id) }
  exportSnapshot(id: string): Promise<Uint8Array> { return this.base.exportSnapshot(id) }
  importSnapshot(bundle: Uint8Array): Promise<BackupSnapshotManifest> { return this.base.importSnapshot(bundle) }
  previewRestore(id: string): Promise<BackupRestorePreview> { return this.base.previewRestore(id) }
}
