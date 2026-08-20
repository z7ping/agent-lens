import type {
  AgentInstallation,
  AgentActor,
  AgentActorIdentityHint,
  AgentInstallation as Installation,
  InstallationIdentityHint,
  Host,
  HostIdentityHint,
  LogicalSession,
  LogicalSessionIdentityHint,
  Project,
  ProjectIdentityHint,
  SourceSession,
  SourceSessionIdentityHint,
  Workspace,
  WorkspaceIdentityHint,
  ObservationIdentityHints,
} from '../domain/identity'
import type {
  AgentInstallationId,
  AssetDefinitionId,
  Disposable,
  EvidenceId,
  ObservationId,
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
import type { DetectedSource, SourceDefinition } from '../contracts/source'

export interface SourceService {
  register(definition: SourceDefinition): Disposable
  list(): SourceDefinition[]
  detect(context?: unknown): Promise<DetectedSource[]>
}

export interface IdentityService {
  resolveHost(hint: HostIdentityHint): Promise<Host>
  resolveInstallation(hint: InstallationIdentityHint): Promise<Installation>
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
  candidate: ObservationCandidate
  evidenceCandidates: EvidenceCandidate[]
  identityHints: ObservationIdentityHints
}

export interface ObservationCommitResult {
  observation: CanonicalObservation
  status: 'created' | 'merged' | 'unchanged'
  mergedEvidenceIds: EvidenceId[]
}

export interface ObservationQuery {
  installationId?: AgentInstallationId
  kind?: CanonicalObservation['kind']
  from?: string
  to?: string
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

export interface ToolService {
  resolveDefinition(input: ToolDefinitionHint): Promise<ToolDefinition>
  findByNativeName(installationId: AgentInstallationId, nativeToolName: string): Promise<ToolDefinition | null>
}

export interface ProjectionScope {
  subjectType?: string
  subjectId?: string
}

export interface ProjectionInvalidation extends ProjectionScope {
  projectionId: string
  reason?: string
}

export interface ProjectionDefinition {
  id: string
  rebuild(scope?: ProjectionScope): Promise<void>
}

export interface ProjectionService {
  register(projection: ProjectionDefinition): Disposable
  rebuild(projectionId: string, scope?: ProjectionScope): Promise<void>
  invalidate(input: ProjectionInvalidation): Promise<void>
}

export interface StorageTransaction {}
export interface StorageHealth {
  ok: boolean
  details?: Readonly<Record<string, unknown>>
}

export interface StorageService {
  transaction<T>(fn: (tx: StorageTransaction) => Promise<T>): Promise<T>
  migrate(): Promise<void>
  health(): Promise<StorageHealth>
}

export interface HostRepository {
  get(id: string): Promise<Host | null>
  put(host: Host): Promise<void>
}

export interface InstallationRepository {
  get(id: AgentInstallationId): Promise<AgentInstallation | null>
  put(installation: AgentInstallation): Promise<void>
}

export interface ObservationRepository {
  get(id: ObservationId): Promise<CanonicalObservation | null>
  query(query: ObservationQuery): Promise<CanonicalObservation[]>
  put(observation: CanonicalObservation): Promise<void>
}

export interface EvidenceRepository {
  get(id: EvidenceId): Promise<Evidence | null>
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
  put(definition: ToolDefinition): Promise<void>
}
