import { createHash } from 'node:crypto'
import type {
  AgentActor,
  AgentInstallation,
  AssetBinding,
  AssetDefinition,
  AssetService,
  AssetStateObservation,
  CapabilityService,
  CanonicalObservation,
  CommitObservationInput,
  CoverageDeclaration,
  CoverageEvaluationInput,
  CoverageQuery,
  CoverageService,
  CoverageStatus,
  DetectedSource,
  Disposable,
  Evidence,
  EvidenceCandidate,
  EvidenceService,
  Host,
  HostIdentityHint,
  IdentityService,
  InstallationIdentityHint,
  LogicalSession,
  LogicalSessionIdentityHint,
  ObservationCapability,
  ObservationCommitResult,
  ObservationQuery,
  ObservationService,
  Project,
  ProjectIdentityHint,
  ProjectionDefinition,
  ProjectionInvalidation,
  ProjectionScope,
  ProjectionService,
  SourceDefinition,
  SourceDetectionContext,
  SourceService,
  SourceSession,
  SourceSessionIdentityHint,
  StorageService,
  ToolDefinition,
  ToolService,
  Workspace,
  WorkspaceIdentityHint,
  AgentActorIdentityHint,
  AssetDefinitionHint,
  AssetBindingHint,
  AssetStateInput,
  ToolDefinitionHint,
} from '@agent-lens/core'

function stableId(prefix: string, parts: unknown[]): string {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)
  return `${prefix}-${digest}`
}

function isoNow(): string {
  return new Date().toISOString()
}

function normalizedPathIdentity(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized
}

export class DefaultSourceService implements SourceService {
  private readonly definitions = new Map<string, SourceDefinition>()

  register(definition: SourceDefinition): Disposable {
    const id = definition.manifest.sourceId
    if (this.definitions.has(id)) {
      throw new Error(`AgentLens source already registered: ${id}`)
    }
    this.definitions.set(id, definition)
    return {
      dispose: () => {
        if (this.definitions.get(id) === definition) this.definitions.delete(id)
      },
    }
  }

  list(): SourceDefinition[] {
    return [...this.definitions.values()]
  }

  async detect(context: SourceDetectionContext): Promise<DetectedSource[]> {
    const detected = await Promise.all(this.list().map(source => source.detect(context)))
    return detected.flat()
  }
}

export class DefaultIdentityService implements IdentityService {
  constructor(private readonly storage: StorageService) {}

  async resolveHost(hint: HostIdentityHint): Promise<Host> {
    const platform = hint.platform ?? 'unknown'
    const arch = hint.arch ?? 'unknown'
    const name = hint.name ?? 'local'
    const id = stableId('host', [name, platform, arch])
    const existing = await this.storage.repositories.hosts.get(id)
    const host: Host = {
      id,
      name,
      platform,
      arch,
      createdAt: existing?.createdAt ?? isoNow(),
      lastSeenAt: isoNow(),
    }
    await this.storage.repositories.hosts.put(host)
    return host
  }

  async resolveInstallation(hint: InstallationIdentityHint): Promise<AgentInstallation> {
    const repository = this.storage.repositories.installations
    if (!await repository.getProduct(hint.productId)) {
      await repository.putProduct({ id: hint.productId, name: hint.productId })
    }

    const id = stableId('installation', [
      hint.hostId,
      hint.productId,
      hint.executable ?? '',
      hint.configRoot ?? '',
      hint.dataRoot ?? '',
    ])
    const existing = await repository.get(id)
    const installation: AgentInstallation = {
      id,
      hostId: hint.hostId,
      productId: hint.productId,
      ...(hint.version ? { version: hint.version } : {}),
      ...(hint.executable ? { executable: hint.executable } : {}),
      ...(hint.configRoot ? { configRoot: hint.configRoot } : {}),
      ...(hint.dataRoot ? { dataRoot: hint.dataRoot } : {}),
      firstSeenAt: existing?.firstSeenAt ?? isoNow(),
      lastSeenAt: isoNow(),
    }
    await repository.put(installation)
    return installation
  }

  async resolveProject(hint: ProjectIdentityHint): Promise<Project | null> {
    const identity = hint.repositoryIdentity ?? hint.name
    if (!identity) return null
    const id = stableId('project', [identity])
    const repository = this.storage.repositories.sessions
    const existing = await repository.getProject(id)
    const project: Project = {
      id,
      ...(hint.name ? { name: hint.name } : {}),
      ...(hint.repositoryIdentity ? { repositoryIdentity: hint.repositoryIdentity } : {}),
      createdAt: existing?.createdAt ?? isoNow(),
      lastSeenAt: isoNow(),
    }
    await repository.putProject(project)
    return project
  }

  async resolveWorkspace(hint: WorkspaceIdentityHint): Promise<Workspace | null> {
    const path = hint.path ?? hint.repositoryRoot
    if (!path) return null
    const repository = this.storage.repositories.sessions
    const project = hint.repositoryRoot || hint.gitRemote
      ? await this.resolveProject({
        ...(hint.repositoryRoot ? { name: hint.repositoryRoot.split(/[\\/]/).filter(Boolean).at(-1) } : {}),
        repositoryIdentity: hint.gitRemote ?? hint.repositoryRoot!,
      })
      : null
    const normalizedPath = normalizedPathIdentity(path)
    const id = stableId('workspace', [hint.hostId, normalizedPath])
    const workspace: Workspace = {
      id,
      hostId: hint.hostId,
      ...(project ? { projectId: project.id } : {}),
      path,
      ...(hint.gitRemote ? { repositoryId: hint.gitRemote } : {}),
    }
    await repository.putWorkspace(workspace)
    return workspace
  }

  async resolveLogicalSession(hint: LogicalSessionIdentityHint): Promise<LogicalSession> {
    const repository = this.storage.repositories.sessions
    const id = stableId('session', [hint.installationId, hint.nativeSessionId])
    const existing = await repository.getLogicalSession(id)
    const session: LogicalSession = {
      id,
      installationId: hint.installationId,
      ...(hint.projectId ?? existing?.projectId ? { projectId: hint.projectId ?? existing!.projectId } : {}),
      ...(hint.workspaceId ?? existing?.workspaceId ? { workspaceId: hint.workspaceId ?? existing!.workspaceId } : {}),
      ...(hint.title ?? existing?.title ? { title: hint.title ?? existing!.title } : {}),
      ...(existing?.startedAt ? { startedAt: existing.startedAt } : {}),
      ...(existing?.endedAt ? { endedAt: existing.endedAt } : {}),
    }
    await repository.putLogicalSession(session)
    return session
  }

  async resolveSourceSession(hint: SourceSessionIdentityHint): Promise<SourceSession> {
    const repository = this.storage.repositories.sessions
    const existing = await repository.findSourceSession(
      hint.sourceId,
      hint.installationId,
      hint.nativeSessionId,
    )
    const session: SourceSession = existing ?? {
      id: stableId('source-session', [hint.sourceId, hint.installationId, hint.nativeSessionId]),
      sourceId: hint.sourceId,
      installationId: hint.installationId,
      nativeSessionId: hint.nativeSessionId,
    }
    const resolved: SourceSession = {
      ...session,
      ...(hint.logicalSessionId ? { logicalSessionId: hint.logicalSessionId } : {}),
      ...(hint.nativeParentSessionId ? { nativeParentSessionId: hint.nativeParentSessionId } : {}),
    }
    await repository.putSourceSession(resolved)
    return resolved
  }

  async resolveActor(hint: AgentActorIdentityHint): Promise<AgentActor | null> {
    if (!hint.nativeActorId && !hint.role) return null
    const role = hint.role ?? 'unknown'
    const id = stableId('actor', [
      hint.installationId,
      hint.logicalSessionId ?? '',
      hint.nativeActorId ?? role,
    ])
    const actor: AgentActor = {
      id,
      installationId: hint.installationId,
      ...(hint.logicalSessionId ? { logicalSessionId: hint.logicalSessionId } : {}),
      role,
      ...(hint.nativeActorId ? { nativeActorId: hint.nativeActorId } : {}),
      evidenceRefs: [],
    }
    await this.storage.repositories.sessions.putActor(actor)
    return actor
  }
}

const confidenceOrder = ['unknown', 'low', 'medium', 'high', 'exact'] as const

function computedConfidence(candidate: EvidenceCandidate): Evidence['confidence'] {
  let value: Evidence['confidence']
  if (candidate.derivation === 'observed' && candidate.nativeStableId) value = 'exact'
  else if (candidate.derivation === 'reported' && candidate.nativeStableId) value = 'high'
  else if (candidate.derivation === 'observed' || candidate.derivation === 'reported') value = 'high'
  else if (candidate.derivation === 'derived') value = 'high'
  else if (candidate.derivation === 'estimated') value = 'medium'
  else value = 'low'

  if (!candidate.confidenceHint) return value
  const computedRank = confidenceOrder.indexOf(value)
  const hintRank = confidenceOrder.indexOf(candidate.confidenceHint)
  return confidenceOrder[Math.min(computedRank, hintRank)]!
}

export function materializeEvidence(candidate: EvidenceCandidate): Evidence {
  const id = stableId('evidence', [
    candidate.sourceRecordId ?? '',
    candidate.captureMethod,
    candidate.derivation,
    candidate.nativeStableId ?? '',
    candidate.sourceLocator ?? null,
    candidate.parserVersion ?? '',
  ])
  return {
    id,
    captureMethod: candidate.captureMethod,
    derivation: candidate.derivation,
    confidence: computedConfidence(candidate),
    ...(candidate.sourceRecordId ? { sourceRecordId: candidate.sourceRecordId } : {}),
    ...(candidate.sourceLocator ? { sourceLocator: candidate.sourceLocator } : {}),
    ...(candidate.parserVersion ? { parserVersion: candidate.parserVersion } : {}),
    ...(candidate.eventTime ? { eventTime: candidate.eventTime } : {}),
    capturedAt: candidate.capturedAt,
    ...(candidate.missingReason ? { missingReason: candidate.missingReason } : {}),
  }
}

export class DefaultEvidenceService implements EvidenceService {
  constructor(private readonly storage: StorageService) {}

  async create(input: EvidenceCandidate): Promise<Evidence> {
    const evidence = materializeEvidence(input)
    await this.storage.repositories.evidence.put(evidence)
    return evidence
  }

  get(id: string): Promise<Evidence | null> {
    return this.storage.repositories.evidence.get(id)
  }

  listForObservation(observationId: string): Promise<Evidence[]> {
    return this.storage.repositories.evidence.listForObservation(observationId)
  }
}

function dedupIdentity(input: CommitObservationInput, logicalSessionId: string): string {
  const hints = input.candidate.dedupHints
  const scope = [input.sourceId, input.installation.id, logicalSessionId, input.candidate.kind]
  if (hints?.nativeEventId) return stableId('observation', [...scope, 'event', hints.nativeEventId])
  if (hints?.nativeCallId) return stableId('observation', [...scope, 'call', hints.nativeCallId])
  if (hints?.sharedEventKey) return stableId('observation', [...scope, 'shared', hints.sharedEventKey])
  if (hints?.sourceSequence !== undefined) return stableId('observation', [...scope, 'sequence', hints.sourceSequence])
  if (hints?.payloadFingerprint) {
    return stableId('observation', [...scope, 'payload', hints.payloadFingerprint, input.candidate.occurredAt ?? ''])
  }
  return stableId('observation', [...scope, input.candidate.occurredAt ?? '', input.candidate.payload])
}

export class DefaultObservationService implements ObservationService {
  constructor(
    private readonly storage: StorageService,
    private readonly identity: IdentityService,
  ) {}

  async commit(input: CommitObservationInput): Promise<ObservationCommitResult> {
    const hints = input.candidate.identityHints
    const workspace = hints.workspacePath || hints.repositoryRoot
      ? await this.identity.resolveWorkspace({
        hostId: input.host.id,
        ...(hints.workspacePath ? { path: hints.workspacePath } : {}),
        ...(hints.repositoryRoot ? { repositoryRoot: hints.repositoryRoot } : {}),
      })
      : null
    const logicalSession = await this.identity.resolveLogicalSession({
      installationId: input.installation.id,
      nativeSessionId: hints.nativeSessionId,
      ...(workspace?.projectId ? { projectId: workspace.projectId } : {}),
      ...(workspace ? { workspaceId: workspace.id } : {}),
      ...(hints.sessionTitle ? { title: hints.sessionTitle } : {}),
    })
    const sourceSession = await this.identity.resolveSourceSession({
      sourceId: input.sourceId,
      installationId: input.installation.id,
      nativeSessionId: hints.nativeSessionId,
      logicalSessionId: logicalSession.id,
      ...(hints.nativeParentSessionId ? { nativeParentSessionId: hints.nativeParentSessionId } : {}),
    })
    const actor = await this.identity.resolveActor({
      installationId: input.installation.id,
      logicalSessionId: logicalSession.id,
      ...(hints.nativeActorId ? { nativeActorId: hints.nativeActorId } : {}),
      ...(hints.actorRole ? { role: hints.actorRole } : {}),
    })
    const observationId = dedupIdentity(input, logicalSession.id)

    return this.storage.transaction(async tx => {
      const createdEvidence = input.evidenceCandidates.map(materializeEvidence)
      for (const evidence of createdEvidence) await tx.evidence.put(evidence)

      const parentObservationId = input.candidate.nativeParentEventId && tx.observations.findIdByNativeEventId
        ? await tx.observations.findIdByNativeEventId(sourceSession.id, input.candidate.nativeParentEventId)
        : null
      const semantic: Omit<CanonicalObservation, 'id' | 'evidenceRefs'> = {
        hostId: input.host.id,
        installationId: input.installation.id,
        ...(workspace?.projectId ? { projectId: workspace.projectId } : {}),
        ...(workspace ? { workspaceId: workspace.id } : {}),
        logicalSessionId: logicalSession.id,
        sourceSessionId: sourceSession.id,
        ...(actor ? { actorId: actor.id } : {}),
        ...(input.candidate.nativeEventId ? { nativeEventId: input.candidate.nativeEventId } : {}),
        ...(input.candidate.nativeParentEventId ? { nativeParentEventId: input.candidate.nativeParentEventId } : {}),
        ...(parentObservationId ? { parentObservationId } : {}),
        kind: input.candidate.kind,
        ...(input.candidate.sourceSequence === undefined ? {} : { sourceSequence: input.candidate.sourceSequence }),
        ...(input.candidate.sourceSequence === undefined ? {} : { canonicalSequence: input.candidate.sourceSequence }),
        ...(input.candidate.occurredAt ? { occurredAt: input.candidate.occurredAt } : {}),
        capturedAt: input.candidate.capturedAt,
        payload: input.candidate.payload,
      }

      const repairChildren = async () => {
        if (input.candidate.nativeEventId && tx.observations.linkChildrenToParent) {
          await tx.observations.linkChildrenToParent(
            sourceSession.id,
            input.candidate.nativeEventId,
            observationId,
          )
        }
      }

      const existing = await tx.observations.get(observationId)
      if (existing) {
        const existingIds = new Set(existing.evidenceRefs)
        const added = createdEvidence.map(item => item.id).filter(id => !existingIds.has(id))
        const merged: CanonicalObservation = {
          id: existing.id,
          ...semantic,
          evidenceRefs: [...existing.evidenceRefs, ...added],
        }
        const semanticChanged = JSON.stringify({ ...existing, evidenceRefs: [] })
          !== JSON.stringify({ ...merged, evidenceRefs: [] })
        if (semanticChanged || added.length) await tx.observations.put(merged)
        await repairChildren()
        if (!semanticChanged && !added.length) {
          return { observation: existing, status: 'unchanged', mergedEvidenceIds: [] }
        }
        return { observation: merged, status: 'merged', mergedEvidenceIds: added }
      }

      const observation: CanonicalObservation = {
        id: observationId,
        ...semantic,
        evidenceRefs: createdEvidence.map(item => item.id),
      }
      await tx.observations.put(observation)
      await repairChildren()
      return {
        observation,
        status: 'created',
        mergedEvidenceIds: createdEvidence.map(item => item.id),
      }
    })
  }

  get(id: string): Promise<CanonicalObservation | null> {
    return this.storage.repositories.observations.get(id)
  }

  query(query: ObservationQuery): Promise<CanonicalObservation[]> {
    return this.storage.repositories.observations.query(query)
  }
}

export class DefaultCoverageService implements CoverageService {
  constructor(
    private readonly storage: StorageService,
    private readonly evidence: EvidenceService,
  ) {}

  async declare(input: CoverageDeclaration) {
    const evidenceRefs: string[] = []
    for (const candidate of input.evidenceCandidates ?? []) {
      evidenceRefs.push((await this.evidence.create(candidate)).id)
    }
    const coverage = {
      id: stableId('coverage', [input.subjectType, input.subjectId, input.capability, input.from ?? '', input.to ?? '']),
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      capability: input.capability,
      ...(input.from ? { from: input.from } : {}),
      ...(input.to ? { to: input.to } : {}),
      status: input.status,
      ...(input.reason ? { reason: input.reason } : {}),
      evidenceRefs,
    }
    await this.storage.repositories.coverage.put(coverage)
    return coverage
  }

  query(query: CoverageQuery) {
    return this.storage.repositories.coverage.query(query)
  }

  async evaluate(input: CoverageEvaluationInput): Promise<CoverageStatus> {
    const rows = await this.query(input)
    if (!rows.length) return 'unknown'
    const rank: Record<CoverageStatus, number> = {
      complete: 0,
      partial: 1,
      unknown: 2,
      unavailable: 3,
    }
    return rows.reduce<CoverageStatus>((worst, item) => rank[item.status] > rank[worst] ? item.status : worst, 'complete')
  }
}

export class DefaultCapabilityService implements CapabilityService {
  private readonly values = new Map<string, Map<string, ObservationCapability>>()

  registerSourceCapabilities(sourceId: string, capabilities: ObservationCapability[]): Disposable {
    const next = new Map(capabilities.map(item => [item.name, item]))
    this.values.set(sourceId, next)
    return { dispose: () => { if (this.values.get(sourceId) === next) this.values.delete(sourceId) } }
  }

  listForSource(sourceId: string): ObservationCapability[] {
    return [...(this.values.get(sourceId)?.values() ?? [])]
  }

  get(sourceId: string, capability: string): ObservationCapability | null {
    return this.values.get(sourceId)?.get(capability) ?? null
  }
}

export class DefaultAssetService implements AssetService {
  constructor(private readonly storage: StorageService) {}

  async resolveDefinition(input: AssetDefinitionHint): Promise<AssetDefinition> {
    const id = stableId('asset', [input.type, input.upstreamIdentity ?? input.canonicalName])
    const definition: AssetDefinition = {
      id,
      type: input.type,
      canonicalName: input.canonicalName,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.upstreamIdentity ? { upstreamIdentity: input.upstreamIdentity } : {}),
    }
    await this.storage.repositories.assets.putDefinition(definition)
    return definition
  }

  async resolveBinding(input: AssetBindingHint): Promise<AssetBinding> {
    const binding: AssetBinding = {
      id: stableId('asset-binding', [input.assetId, input.installationId, input.path ?? '', input.source ?? '']),
      assetId: input.assetId,
      installationId: input.installationId,
      ...(input.path ? { path: input.path } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.version ? { version: input.version } : {}),
    }
    await this.storage.repositories.assets.putBinding(binding)
    return binding
  }

  async recordState(input: AssetStateInput): Promise<AssetStateObservation> {
    const state: AssetStateObservation = {
      id: stableId('asset-state', [input.assetBindingId, input.state, input.observedAt]),
      ...input,
    }
    await this.storage.repositories.assets.putState(state)
    return state
  }
}

export class DefaultToolService implements ToolService {
  constructor(private readonly storage: StorageService) {}

  async resolveDefinition(input: ToolDefinitionHint): Promise<ToolDefinition> {
    const id = stableId('tool', [input.installationId ?? 'global', input.canonicalName])
    const definition: ToolDefinition = {
      id,
      canonicalName: input.canonicalName,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      sourceType: input.sourceType,
      ...(input.assetDefinitionId ? { assetDefinitionId: input.assetDefinitionId } : {}),
      ...(input.installationId ? { installationId: input.installationId } : {}),
      ...(input.schemaHash ? { schemaHash: input.schemaHash } : {}),
    }
    await this.storage.repositories.tools.put(definition)
    return definition
  }

  findByNativeName(installationId: string, nativeToolName: string): Promise<ToolDefinition | null> {
    return this.storage.repositories.tools.get(stableId('tool', [installationId, nativeToolName]))
  }
}

export class DefaultProjectionService implements ProjectionService {
  private readonly projections = new Map<string, ProjectionDefinition>()

  register(projection: ProjectionDefinition): Disposable {
    if (this.projections.has(projection.id)) throw new Error(`Projection already registered: ${projection.id}`)
    this.projections.set(projection.id, projection)
    return { dispose: () => { if (this.projections.get(projection.id) === projection) this.projections.delete(projection.id) } }
  }

  async rebuild(projectionId: string, scope?: ProjectionScope): Promise<void> {
    const projection = this.projections.get(projectionId)
    if (!projection) throw new Error(`Unknown projection: ${projectionId}`)
    await projection.rebuild(scope)
  }

  async flush(projectionId: string): Promise<void> {
    const projection = this.projections.get(projectionId)
    if (!projection) throw new Error(`Unknown projection: ${projectionId}`)
    await projection.flush?.()
  }

  async invalidate(input: ProjectionInvalidation): Promise<void> {
    await this.rebuild(input.projectionId, {
      ...(input.subjectType ? { subjectType: input.subjectType } : {}),
      ...(input.subjectId ? { subjectId: input.subjectId } : {}),
    })
  }
}
