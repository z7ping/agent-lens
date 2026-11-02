import { AGENT_LENS_PROTOCOL_VERSION } from './timeline'

/** Workspace features describe observable provider data, not Source/Live installation permissions. */
export type AgentWorkFeature = 'boards' | 'schedules'
export type AgentWorkAvailability = 'available' | 'unknown' | 'error'
export interface AgentWorkFeatureDto {
  id: AgentWorkFeature
  availability: AgentWorkAvailability
  reason?: string
}
export interface AgentWorkBoardDto {
  id: string
  name: string
  projectId?: string
  archived: boolean
  taskCount: number
}
export interface AgentWorkTaskDto {
  id: string
  boardId: string
  title: string
  status: string
  assignee?: string
  projectId?: string
  priority: number
  createdAt?: string
  lastError?: string
  currentRunId?: number
}
export interface AgentWorkRunDto {
  id: number
  boardId: string
  taskId: string
  profile?: string
  status: string
  outcome?: string
  startedAt?: string
  endedAt?: string
  summary?: string
  error?: string
}
export interface AgentWorkScheduleDto {
  id: string
  profile: string
  name: string
  state: string
  enabled: boolean
  schedule: string
  nextRunAt?: string
  lastRunAt?: string
  lastStatus?: string
  lastError?: string
  noAgent: boolean
  workdir?: string
}
export interface AgentWorkExecutionDto {
  id: string
  jobId: string
  profile: string
  status: string
  claimedAt: string
  startedAt?: string
  finishedAt?: string
  error?: string
  deliveryOutcome?: string
}
export interface AgentWorkProjectDto {
  id: string
  profile: string
  slug: string
  name: string
  archived: boolean
  boardId?: string
  primaryPath?: string
}
export interface AgentWorkspaceResponseDto {
  sourceId: string
  features: AgentWorkFeatureDto[]
  projects: AgentWorkProjectDto[]
  boards: AgentWorkBoardDto[]
  selectedBoard?: string
  tasks: AgentWorkTaskDto[]
  runs: AgentWorkRunDto[]
  tasksHasMore: boolean
  schedules: AgentWorkScheduleDto[]
  executions: AgentWorkExecutionDto[]
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    generatedAt: string
  }
}
