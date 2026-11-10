import { AGENT_LENS_PROTOCOL_VERSION } from './timeline'

/** Workspace features describe observable provider data, not Source/Live installation permissions. */
export type AgentWorkFeature = 'boards' | 'schedules' | 'projects'
export type AgentWorkAvailability = 'available' | 'partial' | 'unknown' | 'error'
export interface AgentWorkFeatureDto {
  id: AgentWorkFeature
  availability: AgentWorkAvailability
  reason?: string | undefined
}
export interface AgentWorkBoardDto {
  id: string
  name: string
  projectId?: string | undefined
  archived: boolean
  taskCount: number
}
export interface AgentWorkTaskDto {
  id: string
  boardId: string
  title: string
  status: string
  assignee?: string | undefined
  projectId?: string | undefined
  priority: number
  createdAt?: string | undefined
  lastError?: string | undefined
  currentRunId?: number | undefined
  sourceSessionNativeId?: string | undefined
}
export interface AgentWorkRunDto {
  id: number
  boardId: string
  taskId: string
  profile?: string | undefined
  status: string
  outcome?: string | undefined
  /** Hermes owner_admitted event; this is the executed worker session, not the originating task session. */
  workerSessionNativeId?: string | undefined
  startedAt?: string | undefined
  endedAt?: string | undefined
  summary?: string | undefined
  error?: string | undefined
}
export interface AgentWorkLinkDto {
  parentId: string
  childId: string
}
export interface AgentWorkCommentDto {
  id: number
  author: string
  body: string
  createdAt?: string | undefined
}
export interface AgentWorkEventDto {
  id: number
  kind: string
  runId?: number | undefined
  createdAt?: string | undefined
}
export interface AgentWorkScheduleDto {
  id: string
  profile: string
  name: string
  state: string
  enabled: boolean
  schedule: string
  nextRunAt?: string | undefined
  lastRunAt?: string | undefined
  lastStatus?: string | undefined
  lastError?: string | undefined
  noAgent: boolean
  workdir?: string | undefined
}
export interface AgentWorkExecutionDto {
  id: string
  jobId: string
  profile: string
  status: string
  claimedAt: string
  startedAt?: string | undefined
  finishedAt?: string | undefined
  error?: string | undefined
  deliveryOutcome?: string | undefined
}
export interface AgentWorkProjectDto {
  id: string
  profile: string
  slug: string
  name: string
  archived: boolean
  boardId?: string | undefined
  primaryPath?: string | undefined
}
export interface AgentWorkspaceResponseDto {
  sourceId: string
  /** Server-selected registered Agent installation; native files are scoped to this identity. */
  installationId?: string | undefined
  features: AgentWorkFeatureDto[]
  /** Provider-issued allowed native actions, not inferred from Agent name. */
  availableActions?: AgentWorkMutationDto['kind'][]
  /** True only when this Source exposes native actions and AgentLens can manage installation-level write access. */
  writeControlAvailable?: boolean | undefined
  projects: AgentWorkProjectDto[]
  projectsHasMore: boolean
  projectsTotal: number
  boards: AgentWorkBoardDto[]
  boardsTotal:number
  boardsHasMore:boolean
  selectedBoard?: string | undefined
  tasks: AgentWorkTaskDto[]
  runs: AgentWorkRunDto[]
  runsHasMore: boolean
  taskCommentsHasMore: boolean
  detailTaskId?: string | undefined
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
  installationId?: string | undefined
  profile: string
  jobId: string
  files: AgentWorkOutputFileDto[]
  hasMore: boolean
  state: 'available' | 'unavailable'
  preview?: { name: string; text: string }
}

/** Explicit, bounded native mutations. Never transport arbitrary CLI arguments. */
export type AgentWorkMutationDto =
  | {kind:'board.create';slug:string;name?:string | undefined}
  | {kind:'board.rename';slug:string;name:string}
  | {kind:'board.archive';slug:string}
  | {kind:'task.create';boardId:string;title:string;body?:string | undefined;assignee?:string | undefined;priority?:number | undefined}
  | {kind:'task.edit';boardId:string;taskId:string;title?:string | undefined;body?:string | undefined;priority?:number | undefined}
  | {kind:'task.assign';boardId:string;taskId:string;profile:string}
  | {kind:'task.link'|'task.unlink';boardId:string;parentId:string;childId:string}
  | {kind:'task.archive';boardId:string;taskId:string}
  | {kind:'task.block'|'task.unblock'|'task.complete'|'task.promote';boardId:string;taskId:string;reason?:string | undefined}
  | {kind:'cron.create';profile:string;schedule:string;prompt:string;name?:string | undefined}
  | {kind:'cron.edit';profile:string;jobId:string;schedule?:string | undefined;prompt?:string | undefined;name?:string | undefined}
  | {kind:'cron.pause'|'cron.resume'|'cron.remove'|'cron.cancel'|'cron.run';profile:string;jobId:string}

export interface AgentWorkWriteAccessDto {
  sourceId: string
  installationId: string
  enabled: boolean
}

export interface AgentWorkMutationResultDto {
  sourceId:string
  installationId:string
  kind:AgentWorkMutationDto['kind']
  /** The native CLI exited successfully. Read-back is required for persisted state. */
  accepted:boolean
  /** A background Hermes CLI is still running. This is not a successful native execution. */
  pending?:boolean | undefined
  receiptId?:string | undefined
  /** Only exact native read-back can mark an operation confirmed. */
  verification?:'confirmed'|'unconfirmed'|'not-verifiable'
  verificationMessage?:string | undefined
  message:string
}

export interface AgentWorkMutationReceiptDto {
  receiptId:string
  status:'running'|'accepted'|'failed'|'unknown'
  message:string
}

/** Explicitly supported safe native verbs; providers must not accept arbitrary CLI. */
export const AGENT_WORK_MUTATION_KINDS:readonly AgentWorkMutationDto['kind'][]=[
  'board.create','board.rename','board.archive',
  'task.create','task.edit','task.assign','task.link','task.unlink','task.archive',
  'task.block','task.unblock','task.complete','task.promote',
  'cron.create','cron.edit','cron.pause','cron.resume','cron.remove','cron.cancel','cron.run',
]
