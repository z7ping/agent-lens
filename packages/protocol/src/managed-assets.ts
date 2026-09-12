import { AGENT_LENS_PROTOCOL_VERSION } from './timeline'

export type ManagedAssetRoot = 'config' | 'data'

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

export interface ManagedAssetFilePreviewResponseDto {
  productId: string
  installationId: string
  root: ManagedAssetRoot
  rootPath: string
  relativePath: string
  name: string
  size: number
  modifiedAt: string
  content: string
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
  }
}
