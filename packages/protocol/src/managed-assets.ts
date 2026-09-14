import { AGENT_LENS_PROTOCOL_VERSION } from './timeline'

export type ManagedAssetRoot = 'config' | 'data' | 'binding'

export interface ManagedAssetFileEntryDto {
  name: string
  relativePath: string
  kind: 'directory' | 'file' | 'symlink' | 'other'
  accessible: boolean
  symlink?: boolean
  size?: number
  modifiedAt?: string
  sensitive?: boolean
  previewable?: boolean
}

export interface ManagedAssetDirectoryResponseDto {
  productId: string
  installationId: string
  root: ManagedAssetRoot
  rootPath: string
  relativePath: string
  entries: ManagedAssetFileEntryDto[]
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
  }
}

export type ManagedAssetPreviewStatus = 'readable' | 'redacted' | 'metadata-only'

export type ManagedAssetPreviewBlockedReason =
  | 'sensitive'
  | 'protected-data'
  | 'too-large'
  | 'binary'
  | 'unreadable'

export interface ManagedAssetFilePreviewResponseDto {
  productId: string
  installationId: string
  root: ManagedAssetRoot
  rootPath: string
  relativePath: string
  name: string
  kind: 'file'
  size: number
  modifiedAt: string
  previewStatus: ManagedAssetPreviewStatus
  blockedReason?: ManagedAssetPreviewBlockedReason
  content?: string
  redacted?: boolean
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
  }
}