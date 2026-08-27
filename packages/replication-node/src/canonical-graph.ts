import type {
  AgentActor,
  AgentInstallation,
  AgentProduct,
  CanonicalObservation,
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

const OLDEST_DEPENDENCY_TIMESTAMP = '1970-01-01T00:00:00.000Z'

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

export interface ObservationReplicaGraphInput {
  nodeId: string
  reader: CanonicalReplicationReader
  observation: CanonicalObservation
  phase: ReplicationHistoryPhase
  policy: ReplicationPolicy
  history: HistoryBoundary
}

export type ObservationReplicaGraphResult =
  | { kind: 'blocked'; reason: 'history-boundary' }
  | { kind: 'graph'; entities: readonly WireEntityEnvelope[] }

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

function body(input: Readonly<Record<string, unknown>>): Readonly<Record<string, CoreJsonValue | undefined>> {
  const output: Record<string, CoreJsonValue | undefined> = {}
  for (const [key, value] of Object.entries(input)) {
    output[key] = value === undefined ? undefined : strictJson(value)
  }
  return output
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

async function required<T>(label: string, id: string, load: () => Promise<T | null>): Promise<T> {
  const value = await load()
  if (!value) throw new Error(`Replication dependency missing: ${label}:${id}`)
  return value
}

function refs(entries: Readonly<Record<string, WireEntityRef | readonly WireEntityRef[] | undefined>>): Readonly<Record<string, WireEntityRef | readonly WireEntityRef[]>> {
  return Object.fromEntries(Object.entries(entries).filter((entry): entry is [string, WireEntityRef | readonly WireEntityRef[]] => entry[1] !== undefined))
}

export async function generateObservationReplicaGraph(
  input: ObservationReplicaGraphInput,
): Promise<ObservationReplicaGraphResult> {
  const common = {
    nodeId: input.nodeId,
    phase: input.phase,
    policy: input.policy,
    history: input.history,
  } as const

  const rootReferences = refs({
    host: nodeEntityRef('Host', input.observation.hostId),
    installation: nodeEntityRef('AgentInstallation', input.observation.installationId),
    project: input.observation.projectId ? nodeEntityRef('Project', input.observation.projectId) : undefined,
    workspace: input.observation.workspaceId ? nodeEntityRef('Workspace', input.observation.workspaceId) : undefined,
    logicalSession: nodeEntityRef('LogicalSession', input.observation.logicalSessionId),
    sourceSession: nodeEntityRef('SourceSession', input.observation.sourceSessionId),
    actor: input.observation.actorId ? nodeEntityRef('AgentActor', input.observation.actorId) : undefined,
    evidence: input.observation.evidenceRefs.map(id => nodeEntityRef('Evidence', id)),
  })

  const root = generateWireEntity({
    ...common,
    entityType: 'CanonicalObservation',
    originEntityId: input.observation.id,
    capturedAt: input.observation.capturedAt,
    body: body(input.observation as unknown as Readonly<Record<string, unknown>>),
    references: rootReferences,
  })
  if (root.kind === 'blocked') return root

  const entities: WireEntityEnvelope[] = []
  const emitted = new Set<string>()

  const emit = (entity: WireEntityEnvelope): void => {
    const key = `${entity.entityType}\u0000${entity.originEntityId}`
    if (emitted.has(key)) return
    emitted.add(key)
    entities.push(entity)
  }

  const generateDependency = (args: Parameters<typeof generateWireEntity>[0]): WireEntityEnvelope => {
    const result = generateWireEntity({ ...args, dependencyRequired: true })
    if (result.kind === 'blocked') throw new Error(`Required dependency blocked: ${args.entityType}:${args.originEntityId}`)
    return result.entity
  }

  const emitProduct = async (productId: string): Promise<void> => {
    const product = await required('AgentProduct', productId, () => input.reader.getAgentProduct(productId))
    emit(generateDependency({
      ...common,
      entityType: 'AgentProduct',
      originEntityId: product.id,
      capturedAt: OLDEST_DEPENDENCY_TIMESTAMP,
      body: body(product as unknown as Readonly<Record<string, unknown>>),
    }))
  }

  const emitHost = async (hostId: string): Promise<void> => {
    const host = await required('Host', hostId, () => input.reader.getHost(hostId))
    emit(generateDependency({
      ...common,
      entityType: 'Host',
      originEntityId: host.id,
      capturedAt: dependencyTimestamp(host.createdAt),
      body: body(host as unknown as Readonly<Record<string, unknown>>),
    }))
  }

  const emitInstallation = async (installationId: string): Promise<void> => {
    const installation = await required('AgentInstallation', installationId, () => input.reader.getInstallation(installationId))
    await emitHost(installation.hostId)
    await emitProduct(installation.productId)
    emit(generateDependency({
      ...common,
      entityType: 'AgentInstallation',
      originEntityId: installation.id,
      capturedAt: dependencyTimestamp(installation.firstSeenAt),
      body: body(installation as unknown as Readonly<Record<string, unknown>>),
      references: refs({
        host: nodeEntityRef('Host', installation.hostId),
        product: agentProductSharedRef(installation.productId),
      }),
    }))
  }

  const emitProject = async (projectId: string): Promise<void> => {
    const project = await required('Project', projectId, () => input.reader.getProject(projectId))
    emit(generateDependency({
      ...common,
      entityType: 'Project',
      originEntityId: project.id,
      capturedAt: dependencyTimestamp(project.createdAt),
      body: body(project as unknown as Readonly<Record<string, unknown>>),
      sharedIdentity: projectAssertion(project),
    }))
  }

  const emitWorkspace = async (workspaceId: string): Promise<void> => {
    const workspace = await required('Workspace', workspaceId, () => input.reader.getWorkspace(workspaceId))
    await emitHost(workspace.hostId)
    if (workspace.projectId) await emitProject(workspace.projectId)
    emit(generateDependency({
      ...common,
      entityType: 'Workspace',
      originEntityId: workspace.id,
      capturedAt: OLDEST_DEPENDENCY_TIMESTAMP,
      body: body(workspace as unknown as Readonly<Record<string, unknown>>),
      references: refs({
        host: nodeEntityRef('Host', workspace.hostId),
        project: workspace.projectId ? nodeEntityRef('Project', workspace.projectId) : undefined,
      }),
    }))
  }

  const emitRuntimeProfile = async (runtimeProfileId: string): Promise<void> => {
    const profile = await required('RuntimeProfile', runtimeProfileId, () => input.reader.getRuntimeProfile(runtimeProfileId))
    await emitInstallation(profile.installationId)
    emit(generateDependency({
      ...common,
      entityType: 'RuntimeProfile',
      originEntityId: profile.id,
      capturedAt: dependencyTimestamp(profile.firstSeenAt),
      body: body(profile as unknown as Readonly<Record<string, unknown>>),
      references: { installation: nodeEntityRef('AgentInstallation', profile.installationId) },
    }))
  }

  const emitLogicalSession = async (logicalSessionId: string): Promise<void> => {
    const session = await required('LogicalSession', logicalSessionId, () => input.reader.getLogicalSession(logicalSessionId))
    await emitInstallation(session.installationId)
    if (session.runtimeProfileId) await emitRuntimeProfile(session.runtimeProfileId)
    if (session.projectId) await emitProject(session.projectId)
    if (session.workspaceId) await emitWorkspace(session.workspaceId)
    emit(generateDependency({
      ...common,
      entityType: 'LogicalSession',
      originEntityId: session.id,
      capturedAt: dependencyTimestamp(session.startedAt),
      body: body(session as unknown as Readonly<Record<string, unknown>>),
      references: refs({
        installation: nodeEntityRef('AgentInstallation', session.installationId),
        runtimeProfile: session.runtimeProfileId ? nodeEntityRef('RuntimeProfile', session.runtimeProfileId) : undefined,
        project: session.projectId ? nodeEntityRef('Project', session.projectId) : undefined,
        workspace: session.workspaceId ? nodeEntityRef('Workspace', session.workspaceId) : undefined,
      }),
    }))
  }

  const emitSourceSession = async (sourceSessionId: string): Promise<void> => {
    const session = await required('SourceSession', sourceSessionId, () => input.reader.getSourceSession(sourceSessionId))
    await emitInstallation(session.installationId)
    if (session.runtimeProfileId) await emitRuntimeProfile(session.runtimeProfileId)
    if (session.logicalSessionId) await emitLogicalSession(session.logicalSessionId)
    emit(generateDependency({
      ...common,
      entityType: 'SourceSession',
      originEntityId: session.id,
      capturedAt: OLDEST_DEPENDENCY_TIMESTAMP,
      body: body(session as unknown as Readonly<Record<string, unknown>>),
      references: refs({
        installation: nodeEntityRef('AgentInstallation', session.installationId),
        runtimeProfile: session.runtimeProfileId ? nodeEntityRef('RuntimeProfile', session.runtimeProfileId) : undefined,
        logicalSession: session.logicalSessionId ? nodeEntityRef('LogicalSession', session.logicalSessionId) : undefined,
      }),
    }))
  }

  const emitActor = async (actorId: string): Promise<void> => {
    const actor = await required('AgentActor', actorId, () => input.reader.getActor(actorId))
    await emitInstallation(actor.installationId)
    if (actor.logicalSessionId) await emitLogicalSession(actor.logicalSessionId)
    if (actor.parentActorId) await emitActor(actor.parentActorId)
    emit(generateDependency({
      ...common,
      entityType: 'AgentActor',
      originEntityId: actor.id,
      capturedAt: OLDEST_DEPENDENCY_TIMESTAMP,
      body: body(actor as unknown as Readonly<Record<string, unknown>>),
      references: refs({
        installation: nodeEntityRef('AgentInstallation', actor.installationId),
        logicalSession: actor.logicalSessionId ? nodeEntityRef('LogicalSession', actor.logicalSessionId) : undefined,
        parentActor: actor.parentActorId ? nodeEntityRef('AgentActor', actor.parentActorId) : undefined,
        evidence: actor.evidenceRefs.map(id => nodeEntityRef('Evidence', id)),
      }),
    }))
  }

  const emitSourceRecord = async (sourceRecordId: string): Promise<void> => {
    const record = await required('SourceRecord', sourceRecordId, () => input.reader.getSourceRecord(sourceRecordId))
    await emitInstallation(record.installationId)
    emit(generateDependency({
      ...common,
      entityType: 'SourceRecord',
      originEntityId: record.id,
      capturedAt: record.capturedAt,
      body: body(record as unknown as Readonly<Record<string, unknown>>),
      references: { installation: nodeEntityRef('AgentInstallation', record.installationId) },
    }))
  }

  const emitEvidence = async (evidenceId: string): Promise<void> => {
    const evidence = await required('Evidence', evidenceId, () => input.reader.getEvidence(evidenceId))
    if (evidence.sourceRecordId) await emitSourceRecord(evidence.sourceRecordId)
    emit(generateDependency({
      ...common,
      entityType: 'Evidence',
      originEntityId: evidence.id,
      capturedAt: evidence.capturedAt,
      body: body(evidence as unknown as Readonly<Record<string, unknown>>),
      references: refs({
        sourceRecord: evidence.sourceRecordId ? nodeEntityRef('SourceRecord', evidence.sourceRecordId) : undefined,
      }),
    }))
  }

  await emitHost(input.observation.hostId)
  await emitInstallation(input.observation.installationId)
  if (input.observation.projectId) await emitProject(input.observation.projectId)
  if (input.observation.workspaceId) await emitWorkspace(input.observation.workspaceId)
  await emitLogicalSession(input.observation.logicalSessionId)
  await emitSourceSession(input.observation.sourceSessionId)
  if (input.observation.actorId) await emitActor(input.observation.actorId)
  for (const evidenceId of input.observation.evidenceRefs) await emitEvidence(evidenceId)

  emit(root.entity)
  return { kind: 'graph', entities }
}
