import { AGENT_LENS_PROTOCOL_VERSION } from './timeline'

export type AgentManagedRootDto = 'config' | 'data'
export type AgentManagedFileKindDto = 'file' | 'directory' | 'symlink' | 'other'

export interface AgentManagedFileEntryDto {
  name: string
  relativePath: string
  kind: AgentManagedFileKindDto
  size?: number
  modifiedAt?: string
}

export interface AgentManagedDirectoryResponseDto {
  sourceId: string
  installationId: string
  root: AgentManagedRootDto
  rootPath: string
  relativePath: string
  entries: AgentManagedFileEntryDto[]
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    generatedAt: string
  }
}

export interface AgentManagedTextPreviewResponseDto {
  sourceId: string
  installationId: string
  root: AgentManagedRootDto
  rootPath: string
  name: string
  relativePath: string
  size: number
  modifiedAt: string
  content: string
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    generatedAt: string
  }
}
