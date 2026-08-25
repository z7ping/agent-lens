import { AGENT_LENS_PROTOCOL_VERSION } from './timeline'

export type BackupAssetKindDto =
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

export interface BackupSnapshotSummaryDto {
  id: string
  createdAt: string
  sourceIds: string[]
  fileCount: number
  excludedCount: number
  totalBytes: number
  manifestSha256: string
}

export interface BackupProtectionSourceDto {
  sourceId: string
  productId: string
  displayName: string
  detected: boolean
  fileCount: number
  excludedCount: number
  kinds: Partial<Record<BackupAssetKindDto, number>>
}

export interface BackupOverviewResponseDto {
  vaultPath: string
  sources: BackupProtectionSourceDto[]
  snapshots: BackupSnapshotSummaryDto[]
  index?: {
    generatedAt: string
    refreshing: boolean
  }
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    generatedAt: string
  }
}

export interface BackupCreateRequestDto {
  sourceIds?: string[]
  kinds?: BackupAssetKindDto[]
}

export interface BackupManifestFileDto {
  sourceId: string
  productId: string
  installationId: string
  sourceScope: 'config' | 'data'
  sourceRelativePath: string
  originalPath: string
  archivePath: string
  kinds: BackupAssetKindDto[]
  size: number
  sha256: string
}

export interface BackupExcludedEntryDto {
  sourceId: string
  productId: string
  installationId: string
  originalPath: string
  kinds: BackupAssetKindDto[]
  reason:
    | 'sensitive-file-name'
    | 'sensitive-content'
    | 'symbolic-link'
    | 'outside-source-roots'
    | 'unreadable'
}

export interface BackupSnapshotManifestDto {
  schemaVersion: 1
  id: string
  createdAt: string
  files: BackupManifestFileDto[]
  excluded: BackupExcludedEntryDto[]
  manifestSha256: string
}

export interface BackupSnapshotResponseDto {
  snapshot: BackupSnapshotManifestDto
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    generatedAt: string
  }
}

export interface BackupVerifyResponseDto {
  snapshotId: string
  valid: boolean
  manifestMatches: boolean
  checkedFiles: number
  missingFiles: string[]
  mismatchedFiles: string[]
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    generatedAt: string
  }
}

export interface BackupRestorePreviewItemDto {
  sourceId: string
  archivePath: string
  targetPath?: string
  kinds: BackupAssetKindDto[]
  status: 'unchanged' | 'missing' | 'modified' | 'blocked'
  reason?: string
}

export interface BackupRestorePreviewResponseDto {
  snapshotId: string
  generatedAt: string
  items: BackupRestorePreviewItemDto[]
  unchanged: number
  missing: number
  modified: number
  blocked: number
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
  }
}
