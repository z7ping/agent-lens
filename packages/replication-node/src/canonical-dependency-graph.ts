import type {
  AgentActor,
  AgentInstallation,
  AgentProduct,
  Evidence,
  Host,
  JsonValue as CoreJsonValue,
  LogicalSession,
  Project,
  RepositorySet,
  RuntimeProfile,
  SourceRecord,
  SourceSession,
  Workspace,
} from '@agent-lens/core'
import {
  projectRepositoryPortableIdentity,
  sharedGroupKeyFor,
  type HistoryBoundary,
  type ReplicationHistoryPhase,
  type ReplicationPolicy,
} from '@agent-lens/core/replication'
import type {
  SharedIdentityAssertion,
  WireEntityEnvelope,
  WireEntityRef,
} from '@agent-lens/protocol/replication'
import {
  agentProductSharedRef,
  generateWireEntity,
  nodeEntityRef,
} from './entity-generator'

export const OLDEST_DEPENDENCY_TIMESTAMP = '1970-01-01T00:00:00.000Z'

export interface CanonicalReplicationReader {
  getHost(id: string): Promise<Host | null>
  getInstallation(id: string): Promise<AgentInstallation | null>
  getAgentProduct(id: string): Promise<AgentProduct | null>
  getProject(id: string): Promise<Project | null>
  getWorkspace(id: string): Promise<Workspace | null>
  getRuntimeProfile(id: string): Promise<RuntimeProfile | null>
  getLogicalSession(id: string): Promise<LogicalSession | null>
  getSourceSession(id: string): Promise<SourceSession | null>
  getActor(id: string): Promise<AgentActor | null>
  getEvidence(id: string): Promise<Evidence | null>
  getSourceRecord(id: string): Promise<SourceRecord | null>
}

export function canonicalReplicationReaderFromRepositories(
  repositories: RepositorySet,
  runtimeProfiles: { get(id: string): Promise<RuntimeProfile | null> },
): CanonicalReplicationReader {
  return {
    getHost: id => repositories.hosts.get(id as Host['id']),
    getInstallation: id => repositories.installations.get(id as AgentInstallation['id']),
    getAgentProduct: id => repositories.installations.getProduct(id as AgentProduct['id']),
    getProject: id => repositories.sessions.getProject(id as Project['id']),
    getWorkspace: id => repositories.sessions.getWorkspace(id as Workspace['id']),
    getRuntimeProfile: id => runtimeProfiles.get(id),
    getLogicalSession: id => repositories.sessions.getLogicalSession(id as LogicalSession['id']),
    getSourceSession: id => repositories.sessions.getSourceSession(id as SourceSession['id']),
    getActor: id => repositories.sessions.getActor(id),
    getEvidence: id => repositories.evidence.get(id as Evidence['id']),
    getSourceRecord: id => repositories.sourceRecords.get(id as SourceRecord['id']),
  }
}

function strictJson(value: unknown): CoreJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Replication JSON does not allow non-finite numbers')
    return value
  }
  if (Array.isArray(value)) return value.map(item => strictJson(item))
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Replication JSON only accepts plain objects')
    }
    const output: Record<string, CoreJsonValue> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) throw new TypeError(`Replication JSON field ${key} is undefined`)
      output[key] = strictJson(item)
    }
    return output
  }
  throw new TypeError(`Unsupported replication JSON value: ${typeof value}`)
}

export function replicationBody(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, CoreJsonValue | undefined>> {
  const output: Record<string, CoreJsonValue | undefined> = {}
  for (const [key, value] of Object.entries(input)) {
    output[key] = value === undefined ? undefined : strictJson(value)
  }
  return output
}

export function replicationRefs(
  entries: Readonly<Record<string, WireEntityRef | readonly WireEntityRef[] | undefined>>,
): Readonly<Record<string, WireEntityRef | readonly WireEntityRef[]>> {
  return Object.fromEntries(
    Object.entries(entries).filter(
      (entry): entry is [string, WireEntityRef | readonly WireEntityRef[]] =>
        entry[1] !== undefined,
    ),
  )
}

function projectAssertion(project: Project): SharedIdentityAssertion | undefined {
  const portable = projectRepositoryPortableIdentity(project.repositoryIdentity)
  if (!portable) return undefined
  return {
    identityAlgorithm: portable.algorithm,
    normalizedPortableIdentity: portable.normalized,
    claimedSharedKey: sharedGroupKeyFor('Project', portable),
  }
}

function dependencyTimestamp(value: string | undefined): string {
  return value ?? OLDEST_DEPENDENCY_TIMESTAMP
}

async function required<T>(
  label: string,
  id: string,
  load: () => Promise<T | null>,
): Promise<T> {
  const value = await load()
  if (!value) throw new Error(`Replication dependency missing: ${label}:${id}`)
  return value
}

export class CanonicalDependencyGraphBuilder {
  private readonly entitiesValue: WireEntityEnvelope[] = []
  private readonly emitted = new Set<string>()
  private readonly visitingActors = new Set<string>()

  constructor(private readonly input: {
    nodeId: string
    reader: CanonicalReplicationReader
    phase: ReplicationHistoryPhase
    policy: ReplicationPolicy
    history: HistoryBoundary
  }) {}

  get entities(): readonly WireEntityEnvelope[] {
    return this.entitiesValue
  }

  emit(entity: WireEntityEnvelope): void {
    const key = this.entityKey(entity.entityType, entity.originEntityId)
    if (this.emitted.has(key)) return
    this.emitted.add(key)
    this.entitiesValue.push(entity)
  }

  has(entityType: string, originEntityId: string): boolean {
    return this.emitted.has(this.entityKey(entityType, originEntityId))
  }

  dependency(args: Parameters<typeof generateWireEntity>[0]): WireEntityEnvelope {
    const result = generateWireEntity({ ...args, dependencyRequired: true })
    if (result.kind === 'blocked') {
      throw new Error(
        `Required dependency blocked: ${args.entityType}:${args.originEntityId}`,
      )
    }
    return result.entity
  }

  async emitProduct(productId: string): Promise<void> {
    const product = await required(
      'AgentProduct',
      productId,
      () => this.input.reader.getAgentProduct(productId),
    )
    this.emit(this.dependency({
      ...this.common(),
      entityType: 'AgentProduct',
      originEntityId: product.id,
      capturedAt: OLDEST_DEPENDENCY_TIMESTAMP,
      body: replicationBody(product as unknown as Readonly<Record<string, unknown>>),
    }))
  }

  async emitHost(hostId: string): Promise<void> {
    const host = await required('Host', hostId, () => this.input.reader.getHost(hostId))
    this.emit(this.dependency({
      ...this.common(),
      entityType: 'Host',
      originEntityId: host.id,
      capturedAt: dependencyTimestamp(host.createdAt),
      body: replicationBody(host as unknown as Readonly<Record<string, unknown>>),
    }))
  }

  async emitInstallation(installationId: string): Promise<void> {
    const installation = await required(
      'AgentInstallation',
      installationId,
      () => this.input.reader.getInstallation(installationId),
    )
    await this.emitHost(installation.hostId)
    await this.emitProduct(installation.productId)
    this.emit(this.dependency({
      ...this.common(),
      entityType: 'AgentInstallation',
      originEntityId: installation.id,
      capturedAt: dependencyTimestamp(installation.firstSeenAt),
      body: replicationBody(installation as unknown as Readonly<Record<string, unknown>>),
      references: replicationRefs({
        host: nodeEntityRef('Host', installation.hostId),
        product: agentProductSharedRef(installation.productId),
      }),
    }))
  }

  async emitProject(projectId: string): Promise<void> {
    const project = await required(
      'Project',
      projectId,
      () => this.input.reader.getProject(projectId),
    )
    const sharedIdentity = projectAssertion(project)
    this.emit(this.dependency({
      ...this.common(),
      entityType: 'Project',
      originEntityId: project.id,
      capturedAt: dependencyTimestamp(project.createdAt),
      body: replicationBody(project as unknown as Readonly<Record<string, unknown>>),
      ...(sharedIdentity === undefined ? {} : { sharedIdentity }),
    }))
  }

  async emitWorkspace(workspaceId: string): Promise<void> {
    const workspace = await required(
      'Workspace',
      workspaceId,
      () => this.input.reader.getWorkspace(workspaceId),
    )
    await this.emitHost(workspace.hostId)
    if (workspace.projectId) await this.emitProject(workspace.projectId)
    this.emit(this.dependency({
      ...this.common(),
      entityType: 'Workspace',
      originEntityId: workspace.id,
      capturedAt: OLDEST_DEPENDENCY_TIMESTAMP,
      body: replicationBody(workspace as unknown as Readonly<Record<string, unknown>>),
      references: replicationRefs({
        host: nodeEntityRef('Host', workspace.hostId),
        project: workspace.projectId
          ? nodeEntityRef('Project', workspace.projectId)
          : undefined,
      }),
    }))
  }

  async emitRuntimeProfile(runtimeProfileId: string): Promise<void> {
    const profile = await required(
      'RuntimeProfile',
      runtimeProfileId,
      () => this.input.reader.getRuntimeProfile(runtimeProfileId),
    )
    await this.emitInstallation(profile.installationId)
    this.emit(this.dependency({
      ...this.common(),
      entityType: 'RuntimeProfile',
      originEntityId: profile.id,
      capturedAt: dependencyTimestamp(profile.firstSeenAt),
      body: replicationBody(profile as unknown as Readonly<Record<string, unknown>>),
      references: {
        installation: nodeEntityRef('AgentInstallation', profile.installationId),
      },
    }))
  }

  async emitLogicalSession(logicalSessionId: string): Promise<void> {
    const session = await required(
      'LogicalSession',
      logicalSessionId,
      () => this.input.reader.getLogicalSession(logicalSessionId),
    )
    await this.emitInstallation(session.installationId)
    if (session.runtimeProfileId) await this.emitRuntimeProfile(session.runtimeProfileId)
    if (session.projectId) await this.emitProject(session.projectId)
    if (session.workspaceId) await this.emitWorkspace(session.workspaceId)
    this.emit(this.dependency({
      ...this.common(),
      entityType: 'LogicalSession',
      originEntityId: session.id,
      capturedAt: dependencyTimestamp(session.startedAt),
      body: replicationBody(session as unknown as Readonly<Record<string, unknown>>),
      references: replicationRefs({
        installation: nodeEntityRef('AgentInstallation', session.installationId),
        runtimeProfile: session.runtimeProfileId
          ? nodeEntityRef('RuntimeProfile', session.runtimeProfileId)
          : undefined,
        project: session.projectId
          ? nodeEntityRef('Project', session.projectId)
          : undefined,
        workspace: session.workspaceId
          ? nodeEntityRef('Workspace', session.workspaceId)
          : undefined,
      }),
    }))
  }

  async emitSourceSession(sourceSessionId: string): Promise<void> {
    const session = await required(
      'SourceSession',
      sourceSessionId,
      () => this.input.reader.getSourceSession(sourceSessionId),
    )
    await this.emitInstallation(session.installationId)
    if (session.runtimeProfileId) await this.emitRuntimeProfile(session.runtimeProfileId)
    if (session.logicalSessionId) await this.emitLogicalSession(session.logicalSessionId)
    this.emit(this.dependency({
      ...this.common(),
      entityType: 'SourceSession',
      originEntityId: session.id,
      capturedAt: OLDEST_DEPENDENCY_TIMESTAMP,
      body: replicationBody(session as unknown as Readonly<Record<string, unknown>>),
      references: replicationRefs({
        installation: nodeEntityRef('AgentInstallation', session.installationId),
        runtimeProfile: session.runtimeProfileId
          ? nodeEntityRef('RuntimeProfile', session.runtimeProfileId)
          : undefined,
        logicalSession: session.logicalSessionId
          ? nodeEntityRef('LogicalSession', session.logicalSessionId)
          : undefined,
      }),
    }))
  }

  async emitSourceRecord(sourceRecordId: string): Promise<void> {
    const record = await required(
      'SourceRecord',
      sourceRecordId,
      () => this.input.reader.getSourceRecord(sourceRecordId),
    )
    await this.emitInstallation(record.installationId)
    this.emit(this.dependency({
      ...this.common(),
      entityType: 'SourceRecord',
      originEntityId: record.id,
      capturedAt: record.capturedAt,
      body: replicationBody(record as unknown as Readonly<Record<string, unknown>>),
      references: {
        installation: nodeEntityRef('AgentInstallation', record.installationId),
      },
    }))
  }

  async emitEvidence(evidenceId: string): Promise<void> {
    const evidence = await required(
      'Evidence',
      evidenceId,
      () => this.input.reader.getEvidence(evidenceId),
    )
    if (evidence.sourceRecordId) await this.emitSourceRecord(evidence.sourceRecordId)
    this.emit(this.dependency({
      ...this.common(),
      entityType: 'Evidence',
      originEntityId: evidence.id,
      capturedAt: evidence.capturedAt,
      body: replicationBody(evidence as unknown as Readonly<Record<string, unknown>>),
      references: replicationRefs({
        sourceRecord: evidence.sourceRecordId
          ? nodeEntityRef('SourceRecord', evidence.sourceRecordId)
          : undefined,
      }),
    }))
  }

  async emitActor(actorId: string): Promise<void> {
    const key = this.entityKey('AgentActor', actorId)
    if (this.emitted.has(key)) return
    if (this.visitingActors.has(actorId)) {
      throw new Error(`Replication dependency cycle: AgentActor:${actorId}`)
    }

    this.visitingActors.add(actorId)
    try {
      const actor = await required(
        'AgentActor',
        actorId,
        () => this.input.reader.getActor(actorId),
      )
      await this.emitInstallation(actor.installationId)
      if (actor.logicalSessionId) await this.emitLogicalSession(actor.logicalSessionId)
      if (actor.parentActorId) await this.emitActor(actor.parentActorId)
      for (const evidenceId of actor.evidenceRefs) await this.emitEvidence(evidenceId)
      this.emit(this.dependency({
        ...this.common(),
        entityType: 'AgentActor',
        originEntityId: actor.id,
        capturedAt: OLDEST_DEPENDENCY_TIMESTAMP,
        body: replicationBody(actor as unknown as Readonly<Record<string, unknown>>),
        references: replicationRefs({
          installation: nodeEntityRef('AgentInstallation', actor.installationId),
          logicalSession: actor.logicalSessionId
            ? nodeEntityRef('LogicalSession', actor.logicalSessionId)
            : undefined,
          parentActor: actor.parentActorId
            ? nodeEntityRef('AgentActor', actor.parentActorId)
            : undefined,
          evidence: actor.evidenceRefs.map(id => nodeEntityRef('Evidence', id)),
        }),
      }))
    } finally {
      this.visitingActors.delete(actorId)
    }
  }

  private common() {
    return {
      nodeId: this.input.nodeId,
      phase: this.input.phase,
      policy: this.input.policy,
      history: this.input.history,
    } as const
  }

  private entityKey(entityType: string, originEntityId: string): string {
    return `${entityType}\u0000${originEntityId}`
  }
}
