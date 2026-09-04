import type {
  AgentActor,
  AgentActorIdentityHint,
  AgentInstallation,
  AgentProduct,
  Host,
  HostIdentityHint,
  InstallationIdentityHint,
  Interaction,
  LogicalSession,
  LogicalSessionIdentityHint,
  Project,
  ProjectIdentityHint,
  SessionRelationship,
  SourceSession,
  SourceSessionIdentityHint,
  Workspace,
  WorkspaceIdentityHint,
} from '../domain/identity'
import type {
  AgentInstallationId,
  AgentProductId,
  AssetDefinitionId,
  Disposable,
  EvidenceId,
  HostId,
  InteractionId,
  JsonValue,
  LogicalSessionId,
  ObservationId,
  ProjectId,
  SourceRecordId,
  SourceSessionId,
  WorkspaceId,
} from '../domain/common'
import type {
  CanonicalObservation,
  CoverageDeclaration,
  CoverageStatus,
  Evidence,
  EvidenceCandidate,
  ObservationCapability,
  ObservationCandidate,
  ObservationCoverage,
  SourceRecord,
} from '../domain/observation'
import type {
  AssetBinding,
  AssetBindingHint,
  AssetDefinition,
  AssetDefinitionHint,
  AssetStateInput,
  AssetStateObservation,
  ToolDefinition,
  ToolDefinitionHint,
} from '../domain/assets'
import type {
  DetectedSource,
  SourceDefinition,
  SourceDetectionContext,
} from '../contracts/source'

export interface SourceService {
  register(definition: SourceDefinition): Disposable
  list(): SourceDefinition[]
  detect(context: SourceDetectionContext): Promise<DetectedSource[]>
}

export interface IdentityService {
  resolveHost(hint: HostIdentityHint): Promise<Host>
  resolveInstallation(hint: InstallationIdentityHint): Promise<AgentInstallation>
  resolveProject(hint: ProjectIdentityHint): Promise<Project | null>
  resolveWorkspace(hint: WorkspaceIdentityHint): Promise<Workspace | null>
  resolveLogicalSession(hint: LogicalSessionIdentityHint): Promise<LogicalSession>
  resolveSourceSession(hint: SourceSessionIdentityHint): Promise<SourceSession>
  resolveActor(hint: AgentActorIdentityHint): Promise<AgentActor | null>
}

export interface EvidenceService {
  create(input: EvidenceCandidate): Promise<Evidence>
  get(id: EvidenceId): Promise<Evidence | null>
  listForObservation(observationId: ObservationId): Promise<Evidence[]>
}

export interface CommitObservationInput {
  sourceId: string
  host: Host
  installation: AgentInstallation
  candidate: ObservationCandidate
  evidenceCandidates: EvidenceCandidate[]
}

export interface ObservationCommitResult {
  observation: CanonicalObservation
  status: 'created' | 'merged' | 'unchanged'
  mergedEvidenceIds: EvidenceId[]
}

export interface ObservationCursor {
  effectiveAt: string
  sequence?: number
  id: ObservationId
}

export interface ObservationQuery {
  installationId?: AgentInstallationId
  logicalSessionId?: LogicalSessionId
  logicalSessionIds?: LogicalSessionId[]
  kind?: CanonicalObservation['kind']
  from?: string
  to?: string
  after?: ObservationCursor
  before?: ObservationCursor
  order?: 'asc' | 'desc'
  limit?: number
}

export interface ObservationService {
  commit(input: CommitObservationInput): Promise<ObservationCommitResult>
  get(id: ObservationId): Promise<CanonicalObservation | null>
  query(query: ObservationQuery): Promise<CanonicalObservation[]>
}

export interface CoverageQuery {
  subjectType?: string
  subjectId?: string
  capability?: string
  from?: string
  to?: string
}

export interface CoverageEvaluationInput extends CoverageQuery {
  required?: CoverageStatus[]
}

export interface CoverageService {
  declare(input: CoverageDeclaration): Promise<ObservationCoverage>
  query(query: CoverageQuery): Promise<ObservationCoverage[]>
  evaluate(input: CoverageEvaluationInput): Promise<CoverageStatus>
}

export interface CapabilityService {
  registerSourceCapabilities(sourceId: string, capabilities: ObservationCapability[]): Disposable
  listForSource(sourceId: string): ObservationCapability[]
  get(sourceId: string, capability: string): ObservationCapability | null
}

export interface AssetService {
  resolveDefinition(input: AssetDefinitionHint): Promise<AssetDefinition>
  resolveBinding(input: AssetBindingHint): Promise<AssetBinding>
  recordState(input: AssetStateInput): Promise<AssetStateObservation>
}

export interface AssetInventoryEntry {
  definition: AssetDefinition
  binding: AssetBinding
  states: AssetStateObservation[]
}

/** Read-only storage contract used by projections and surfaces. */
export interface AssetInventoryReader {
  listByInstallation(installationId: AgentInstallationId): Promise<AssetInventoryEntry[]>
}

export type SessionActivityKind = 'user-task' | 'branch-task' | 'subagent' | 'internal-review' | 'system-activity'

export interface SessionSummaryRecord {
  logicalSessionId: LogicalSessionId
  installationId: AgentInstallationId
  productId: AgentProductId
  sourceIds: string[]
  projectId?: ProjectId
  projectName?: string
  workspaceId?: WorkspaceId
  workspacePath?: string
  title?: string
  firstUserPayload?: JsonValue
  startedAt: string
  endedAt: string
  observationCount: number
  /** Backward compatible name; now strictly means real human user turns. */
  interactionCount: number
  userTurnCount?: number
  systemContextCount?: number
  internalReviewCount?: number
  otherEventCount?: number
  toolCount: number
  errorCount: number
  sessionActivity?: SessionActivityKind
  activitySourceLabel?: string
  parentSessionId?: LogicalSessionId
}

export interface SessionSummaryCursor {
  /** Canonical pagination boundary: latest observable activity time for the session. */
  activeAt?: string
  /** @deprecated Legacy cursor field accepted during the alpha.3 transition. */
  startedAt?: string
  logicalSessionId: LogicalSessionId
}

export interface SessionSummaryQuery {
  limit: number
  installationId?: AgentInstallationId
  logicalSessionId?: LogicalSessionId
  sourceId?: string
  projectId?: ProjectId
  from?: string
  to?: string
  hasErrors?: boolean
  search?: string
  after?: SessionSummaryCursor
}

export interface SessionSummaryReader {
  query(input: SessionSummaryQuery): Promise<{ items: SessionSummaryRecord[]; hasMore: boolean }>
}

/**
 * Writable derived view used by the Session Summary projection. Implementations
 * must be fully rebuildable from Canonical Observation data.
 */
export interface SessionSummaryProjectionStore extends SessionSummaryReader {
  /** Cheap integrity guard used before trusting a persisted projection across restarts. */
  isMaterialized(): Promise<boolean>
  rebuild(input?: {
    logicalSessionId?: LogicalSessionId
    strategy?: 'atomic' | 'cooperative'
    signal?: AbortSignal
  }): Promise<void>
}

export interface ToolService {
  resolveDefinition(input: ToolDefinitionHint): Promise<ToolDefinition>
  findByNativeName(installationId: AgentInstallationId, nativeToolName: string): Promise<ToolDefinition | null>
}

export interface ProjectionScope {
  subjectType?: string
  subjectId?: string
  /** Optional cancellation boundary for long-running rebuilds. */
  signal?: AbortSignal
}

export interface ProjectionInvalidation extends ProjectionScope {
  projectionId: string
  reason?: string
}

export interface ProjectionDefinition {
  id: string
  rebuild(scope?: ProjectionScope): Promise<void>
  /** Drain pending incremental work before a controlled shutdown. */
  flush?(): Promise<void>
}

export interface ProjectionService {
  register(projection: ProjectionDefinition): Disposable
  rebuild(projectionId: string, scope?: ProjectionScope): Promise<void>
  flush(projectionId: string): Promise<void>
  invalidate(input: ProjectionInvalidation): Promise<void>
}

export interface HostRepository {
  get(id: HostId): Promise<Host | null>
  put(host: Host): Promise<void>
}

export interface InstallationRepository {
  getProduct(id: AgentProductId): Promise<AgentProduct | null>
  putProduct(product: AgentProduct): Promise<void>
  get(id: AgentInstallationId): Promise<AgentInstallation | null>
  listByProduct(productId: AgentProductId): Promise<AgentInstallation[]>
  put(installation: AgentInstallation): Promise<void>
}

export interface SessionRepository {
  getProject(id: ProjectId): Promise<Project | null>
  putProject(project: Project): Promise<void>
  getWorkspace(id: WorkspaceId): Promise<Workspace | null>
  putWorkspace(workspace: Workspace): Promise<void>
  getLogicalSession(id: LogicalSessionId): Promise<LogicalSession | null>
  putLogicalSession(session: LogicalSession): Promise<void>
  getSourceSession(id: SourceSessionId): Promise<SourceSession | null>
  findSourceSession(
    sourceId: string,
    installationId: AgentInstallationId,
    nativeSessionId: string,
  ): Promise<SourceSession | null>
  putSourceSession(session: SourceSession): Promise<void>
  putRelationship(relationship: SessionRelationship): Promise<void>
  listRelationships(logicalSessionId: LogicalSessionId): Promise<SessionRelationship[]>
  getActor(id: string): Promise<AgentActor | null>
  putActor(actor: AgentActor): Promise<void>
  getInteraction(id: InteractionId): Promise<Interaction | null>
  putInteraction(interaction: Interaction): Promise<void>
}

export interface SourceRecordReplayCursor {
  capturedAt: string
  id: SourceRecordId
}

export interface SourceRecordRepository {
  get(id: SourceRecordId): Promise<SourceRecord | null>
  listForParserReplay?(
    sourceId: string,
    installationId: AgentInstallationId,
    currentParserVersion: string,
    after?: SourceRecordReplayCursor,
    limit?: number,
    window?: { activeSince?: string; sessionLimit?: number },
  ): Promise<SourceRecord[]>
  findByNativeId(
    sourceId: string,
    installationId: AgentInstallationId,
    nativeId: string,
  ): Promise<SourceRecord | null>
  put(record: SourceRecord): Promise<void>
}

export interface ObservationRepository {
  get(id: ObservationId): Promise<CanonicalObservation | null>
  query(query: ObservationQuery): Promise<CanonicalObservation[]>
  findIdByNativeEventId?(
    sourceSessionId: SourceSessionId,
    nativeEventId: string,
  ): Promise<ObservationId | null>
  linkChildrenToParent?(
    sourceSessionId: SourceSessionId,
    nativeParentEventId: string,
    parentObservationId: ObservationId,
  ): Promise<void>
  /**
   * Detach the canonical observations previously derived from one raw SourceRecord.
   * Evidence rows and SourceRecord rows stay intact; observations with other evidence survive.
   */
  removeDerivationsForSourceRecord?(sourceRecordId: SourceRecordId): Promise<number>
  put(observation: CanonicalObservation): Promise<void>
}

export interface EvidenceRepository {
  get(id: EvidenceId): Promise<Evidence | null>
  getMany?(ids: EvidenceId[]): Promise<Evidence[]>
  put(evidence: Evidence): Promise<void>
  listForObservation(observationId: ObservationId): Promise<Evidence[]>
}

export interface CoverageRepository {
  put(coverage: ObservationCoverage): Promise<void>
  query(query: CoverageQuery): Promise<ObservationCoverage[]>
}

export interface AssetRepository {
  getDefinition(id: AssetDefinitionId): Promise<AssetDefinition | null>
  putDefinition(definition: AssetDefinition): Promise<void>
  putBinding(binding: AssetBinding): Promise<void>
  putState(state: AssetStateObservation): Promise<void>
}

export interface ToolRepository {
  get(id: string): Promise<ToolDefinition | null>
  put(definition: ToolDefinition): Promise<void>
}

export interface RepositorySet {
  hosts: HostRepository
  installations: InstallationRepository
  sessions: SessionRepository
  sourceRecords: SourceRecordRepository
  observations: ObservationRepository
  evidence: EvidenceRepository
  coverage: CoverageRepository
  assets: AssetRepository
  tools: ToolRepository
}

export interface CheckpointRepository {
  get<T>(scope: string, key: string): Promise<T | null>
  set<T>(scope: string, key: string, value: T): Promise<void>
  clear(scope: string, key: string): Promise<void>
}

export interface StorageTransaction extends RepositorySet {}

export interface StorageHealth {
  ok: boolean
  schemaVersion?: number
  details?: Readonly<Record<string, unknown>>
}

export interface StorageService {
  readonly repositories: RepositorySet
  readonly checkpoints: CheckpointRepository
  readonly assetInventory?: AssetInventoryReader
  readonly sessionSummaries?: SessionSummaryReader
  readonly sessionSummaryProjection?: SessionSummaryProjectionStore
  transaction<T>(fn: (tx: StorageTransaction) => Promise<T>): Promise<T>
  health(): Promise<StorageHealth>
}
