import { AGENT_LENS_PROTOCOL_VERSION } from './timeline'

/** Workspace features describe observable provider data, not Source/Live installation permissions. */
export type AgentWorkFeature = 'boards' | 'schedules' | 'projects'
export type AgentWorkAvailability = 'available' | 'partial' | 'unknown' | 'error'
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
  sourceSessionNativeId?: string
}
export interface AgentWorkRunDto {
  id: number
  boardId: string
  taskId: string
  profile?: string
  status: string
  outcome?: string
  /** Hermes owner_admitted event; this is the executed worker session, not the originating task session. */
  workerSessionNativeId?: string
  startedAt?: string
  endedAt?: string
  summary?: string
  error?: string
}
export interface AgentWorkLinkDto {
  parentId: string
  childId: string
}
export interface AgentWorkCommentDto {
  id: number
  author: string
  body: string
  createdAt?: string
}
export interface AgentWorkEventDto {
  id: number
  kind: string
  runId?: number
  createdAt?: string
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
  /** Server-selected registered Agent installation; native files are scoped to this identity. */
  installationId?: string
  features: AgentWorkFeatureDto[]
  /** Provider-issued allowed native actions, not inferred from Agent name. */
  availableActions?: AgentWorkMutationDto['kind'][]
  projects: AgentWorkProjectDto[]
  projectsHasMore: boolean
  projectsTotal: number
  boards: AgentWorkBoardDto[]
  boardsTotal:number
  boardsHasMore:boolean
  selectedBoard?: string
  tasks: AgentWorkTaskDto[]
  runs: AgentWorkRunDto[]
  runsHasMore: boolean
  taskCommentsHasMore: boolean
  detailTaskId?: string
  taskLinks: AgentWorkLinkDto[]
  taskComments: AgentWorkCommentDto[]
  taskEvents: AgentWorkEventDto[]
  taskEventsHasMore: boolean
  tasksHasMore: boolean
  schedules: AgentWorkScheduleDto[]
  schedulesHasMore: boolean
  schedulesTotal: number
  executions: AgentWorkExecutionDto[]
  executionsHasMore: boolean
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    generatedAt: string
  }
}

export interface AgentWorkOutputFileDto {
  name: string
  bytes: number
  modifiedAt: string
}
export interface AgentWorkOutputResponseDto {
  sourceId: string
  installationId?: string
  profile: string
  jobId: string
  files: AgentWorkOutputFileDto[]
  hasMore: boolean
  state: 'available' | 'unavailable'
  preview?: { name: string; text: string }
}

/** Explicit, bounded native mutations. Never transport arbitrary CLI arguments. */
export type AgentWorkMutationDto =
  | {kind:'board.create';slug:string;name?:string}
  | {kind:'board.rename';slug:string;name:string}
  | {kind:'board.archive';slug:string}
  | {kind:'task.create';boardId:string;title:string;body?:string;assignee?:string;priority?:number}
  | {kind:'task.edit';boardId:string;taskId:string;title?:string;body?:string;priority?:number}
  | {kind:'task.assign';boardId:string;taskId:string;profile:string}
  | {kind:'task.link'|'task.unlink';boardId:string;parentId:string;childId:string}
  | {kind:'task.archive';boardId:string;taskId:string}
  | {kind:'task.block'|'task.unblock'|'task.complete'|'task.promote';boardId:string;taskId:string;reason?:string}
  | {kind:'cron.create';profile:string;schedule:string;prompt:string;name?:string}
  | {kind:'cron.edit';profile:string;jobId:string;schedule?:string;prompt?:string;name?:string}
  | {kind:'cron.pause'|'cron.resume'|'cron.remove'|'cron.cancel';profile:string;jobId:string}

export interface AgentWorkMutationResultDto {
  sourceId:string
  installationId:string
  kind:AgentWorkMutationDto['kind']
  /** The native CLI exited successfully. Read-back is required for persisted state. */
  accepted:boolean
  message:string
}

/** Explicitly supported safe native verbs; providers must not accept arbitrary CLI. */
export const AGENT_WORK_MUTATION_KINDS:readonly AgentWorkMutationDto['kind'][]=[
  'board.create','board.rename','board.archive',
  'task.create','task.edit','task.assign','task.link','task.unlink','task.archive',
  'task.block','task.unblock','task.complete','task.promote',
  'cron.create','cron.edit','cron.pause','cron.resume','cron.remove','cron.cancel',
]
