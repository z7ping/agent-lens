import type {
  AgentActorId,
  AgentInstallationId,
  AgentProductId,
  Confidence,
  EvidenceId,
  HostId,
  InteractionId,
  LogicalSessionId,
  ProjectId,
  SourceSessionId,
  WorkspaceId,
} from './common'

export interface Host {
  id: HostId
  name: string
  platform: string
  arch: string
  createdAt: string
  lastSeenAt: string
}

export interface AgentProduct {
  id: AgentProductId
  name: string
  vendor?: string
  homepage?: string
}

export interface AgentInstallation {
  id: AgentInstallationId
  hostId: HostId
  productId: AgentProductId
  version?: string
  executable?: string
  configRoot?: string
  dataRoot?: string
  firstSeenAt: string
  lastSeenAt: string
}

export interface Project {
  id: ProjectId
  name?: string
  repositoryIdentity?: string
  createdAt: string
  lastSeenAt: string
}

export interface Workspace {
  id: WorkspaceId
  hostId: HostId
  projectId?: ProjectId
  path: string
  repositoryId?: string
  worktreeId?: string
}

export interface LogicalSession {
  id: LogicalSessionId
  installationId: AgentInstallationId
  projectId?: ProjectId
  workspaceId?: WorkspaceId
  title?: string
  startedAt?: string
  endedAt?: string
}

export interface SourceSession {
  id: SourceSessionId
  sourceId: string
  installationId: AgentInstallationId
  nativeSessionId: string
  logicalSessionId?: LogicalSessionId
  nativeParentSessionId?: string
}

export type SessionRelationshipType =
  | 'resume'
  | 'continuation'
  | 'fork'
  | 'subagent'
  | 'import-copy'
  | 'related'

export interface SessionRelationship {
  id: string
  fromSessionId: LogicalSessionId
  toSessionId: LogicalSessionId
  type: SessionRelationshipType
  evidenceRefs: EvidenceId[]
  confidence: Confidence
}

export type AgentActorRole = 'main-agent' | 'subagent' | 'worker-agent' | 'unknown'

export interface AgentActor {
  id: AgentActorId
  installationId: AgentInstallationId
  logicalSessionId?: LogicalSessionId
  parentActorId?: AgentActorId
  role: AgentActorRole
  nativeActorId?: string
  evidenceRefs: EvidenceId[]
}

export type InteractionTrigger =
  | 'user'
  | 'system'
  | 'resume'
  | 'followup'
  | 'background'
  | 'unknown'

export interface Interaction {
  id: InteractionId
  logicalSessionId: LogicalSessionId
  ordinal: number
  trigger: InteractionTrigger
  startObservationId?: string
  endObservationId?: string
  startedAt?: string
  endedAt?: string
}

export interface HostIdentityHint {
  name?: string
  platform?: string
  arch?: string
}

export interface InstallationIdentityHint {
  hostId: HostId
  productId: AgentProductId
  executable?: string
  version?: string
  configRoot?: string
  dataRoot?: string
}

export interface ProjectIdentityHint {
  name?: string
  repositoryIdentity?: string
}

export interface WorkspaceIdentityHint {
  hostId: HostId
  path?: string
  repositoryRoot?: string
  gitRemote?: string
}

export interface LogicalSessionIdentityHint {
  installationId: AgentInstallationId
  nativeSessionId: string
  projectId?: ProjectId
  workspaceId?: WorkspaceId
}

export interface SourceSessionIdentityHint {
  sourceId: string
  installationId: AgentInstallationId
  nativeSessionId: string
  logicalSessionId?: LogicalSessionId
  nativeParentSessionId?: string
}

export interface AgentActorIdentityHint {
  installationId: AgentInstallationId
  logicalSessionId?: LogicalSessionId
  nativeActorId?: string
  role?: AgentActorRole
}

export interface ObservationIdentityHints {
  nativeSessionId: string
  nativeParentSessionId?: string
  workspacePath?: string
  repositoryRoot?: string
  nativeActorId?: string
  actorRole?: AgentActorRole
  interactionNativeId?: string
  modelName?: string
}
