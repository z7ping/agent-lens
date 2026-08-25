export type BackupAssetKind =
  | 'skill'
  | 'mcp'
  | 'plugin'
  | 'extension'
  | 'hook'
  | 'memory'
  | 'rule'
  | 'session'
  | 'config'
  | 'other'

export type BackupSourceScope = 'config' | 'data'

export interface BackupKindSummary {
  fileCount: number
  totalBytes: number
  logicalAssetCount?: number
}

export interface BackupDataRootSummary {
  scope: BackupSourceScope
  path: string
  fileCount: number
  totalBytes: number
}

export interface BackupAgeBucketSummary {
  fileCount: number
  totalBytes: number
}

export interface BackupProtectionSource {
  sourceId: string
  productId: string
  displayName: string
  detected: boolean
  fileCount: number
  totalBytes: number
  logicalAssetCount: number
  excludedCount: number
  kinds: Partial<Record<BackupAssetKind, number>>
  kindDetails: Partial<Record<BackupAssetKind, BackupKindSummary>>
  roots: BackupDataRootSummary[]
  oldestModifiedAt?: string
  latestModifiedAt?: string
  ageBuckets: {
    recent30Days: BackupAgeBucketSummary
    days31To90: BackupAgeBucketSummary
    days91To180: BackupAgeBucketSummary
    olderThan180Days: BackupAgeBucketSummary
  }
}

export interface BackupSnapshotSummary {
  id: string
  createdAt: string
  sourceIds: string[]
  fileCount: number
  excludedCount: number
  totalBytes: number
  manifestSha256: string
}

export interface BackupManifestFile {
  sourceId: string
  productId: string
  installationId: string
  sourceScope: BackupSourceScope
  sourceRelativePath: string
  originalPath: string
  archivePath: string
  kinds: BackupAssetKind[]
  size: number
  sha256: string
}

export interface BackupExcludedEntry {
  sourceId: string
  productId: string
  installationId: string
  originalPath: string
  kinds: BackupAssetKind[]
  reason:
    | 'sensitive-file-name'
    | 'sensitive-content'
    | 'symbolic-link'
    | 'outside-source-roots'
    | 'unreadable'
}

export interface BackupSnapshotManifest {
  schemaVersion: 1
  id: string
  createdAt: string
  files: BackupManifestFile[]
  excluded: BackupExcludedEntry[]
  manifestSha256: string
}

export interface BackupIndexStatus {
  generatedAt: string
  refreshing: boolean
}

export interface BackupOverview {
  vaultPath: string
  sources: BackupProtectionSource[]
  snapshots: BackupSnapshotSummary[]
  index?: BackupIndexStatus
}

export interface BackupCreateInput {
  sourceIds?: string[]
  kinds?: BackupAssetKind[]
}

export interface BackupVerifyResult {
  snapshotId: string
  valid: boolean
  manifestMatches: boolean
  checkedFiles: number
  missingFiles: string[]
  mismatchedFiles: string[]
}

export type BackupRestoreStatus = 'unchanged' | 'missing' | 'modified' | 'blocked'

export interface BackupRestorePreviewEntry {
  sourceId: string
  archivePath: string
  targetPath?: string
  kinds: BackupAssetKind[]
  status: BackupRestoreStatus
  reason?: string
}

export interface BackupRestorePreview {
  snapshotId: string
  generatedAt: string
  items: BackupRestorePreviewEntry[]
  unchanged: number
  missing: number
  modified: number
  blocked: number
}

export interface BackupService {
  overview(input?: BackupCreateInput): Promise<BackupOverview>
  refreshIndex?(input?: BackupCreateInput): Promise<BackupOverview>
  listSnapshots(): Promise<BackupSnapshotSummary[]>
  getSnapshot(id: string): Promise<BackupSnapshotManifest | null>
  createSnapshot(input?: BackupCreateInput): Promise<BackupSnapshotManifest>
  verifySnapshot(id: string): Promise<BackupVerifyResult>
  exportSnapshot(id: string): Promise<Uint8Array>
  importSnapshot(bundle: Uint8Array): Promise<BackupSnapshotManifest>
  previewRestore(id: string): Promise<BackupRestorePreview>
}
