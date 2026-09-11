import { AGENT_LENS_PROTOCOL_VERSION } from './timeline'

export interface LaunchableProjectDto {
  key: string
  projectId?: string
  projectName?: string
  repositoryIdentity?: string
  workspaceId: string
  workspacePath: string
  lastSeenAt: string
}

export interface LaunchableProjectsResponseDto {
  items: LaunchableProjectDto[]
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    count: number
    hasMore: boolean
    nextCursor?: string
    generatedAt: string
  }
}
