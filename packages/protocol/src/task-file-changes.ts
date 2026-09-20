import { AGENT_LENS_PROTOCOL_VERSION } from './timeline'

export type TaskFileChangeDtoType = 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown'
export type TaskFileChangeDtoConfidence = 'exact' | 'high' | 'medium' | 'low'

export interface TaskFileChangeDto {
  path: string
  changeType: TaskFileChangeDtoType
  oldPath?: string
  additions?: number
  deletions?: number
  firstChangedAt: string
  lastChangedAt: string
  evidence: Array<'tool' | 'filesystem' | 'git'>
  confidence: TaskFileChangeDtoConfidence
}

export interface TaskFileChangesResponseDto {
  logicalSessionId: string
  workspacePath?: string
  rootPath?: string
  items: TaskFileChangeDto[]
  summary: {
    count: number
    additions?: number
    deletions?: number
    exactCount: number
    observedCount: number
  }
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    generatedAt: string
  }
}
