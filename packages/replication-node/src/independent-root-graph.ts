import {
  assetUpstreamPortableIdentity,
  projectRepositoryPortableIdentity,
  sharedGroupKeyFor,
  type HistoryBoundary,
  type IndependentReplicationRootSnapshot,
  type IndependentReplicationRootSnapshotSource,
  type ReplicationHistoryPhase,
  type ReplicationPolicy,
} from '@agent-lens/core/replication'
import type {
  SharedIdentityAssertion,
  WireEntityEnvelope,
} from '@agent-lens/protocol/replication'
import {
  CanonicalDependencyGraphBuilder,
  replicationBody,
  replicationRefs,
  type CanonicalReplicationReader,
} from './canonical-dependency-graph'
import {
  agentProductSharedRef,
  generateWireEntity,
  nodeEntityRef,
} from './entity-generator'

export interface IndependentRootReplicaGraphInput {
  nodeId: string
  dependencies: CanonicalReplicationReader
  roots: IndependentReplicationRootSnapshotSource
  root: IndependentReplicationRootSnapshot
  phase: ReplicationHistoryPhase
  policy: ReplicationPolicy
  history: HistoryBoundary
}

export type IndependentRootReplicaGraphResult =
  | { kind: 'blocked'; reason: 'history-boundary' }
  | { kind: 'graph'; entities: readonly WireEntityEnvelope[] }

function assetAssertion(
  upstreamIdentity: string | undefined,
): SharedIdentityAssertion | undefined {
  const portable = assetUpstreamPortableIdentity(upstreamIdentity)
  if (!portable) return undefined
  return {
    identityAlgorithm: portable.algorithm,
    normalizedPortableIdentity: portable.normalized,
    claimedSharedKey: sharedGroupKeyFor('AssetDefinition', portable),
  }
}

function projectAssertion(
  repositoryIdentity: string | undefined,
): SharedIdentityAssertion | undefined {
  const portable = projectRepositoryPortableIdentity(repositoryIdentity)
  if (!portable) return undefined
  return {
    identityAlgorithm: portable.algorithm,
    normalizedPortableIdentity: portable.normalized,
    claimedSharedKey: sharedGroupKeyFor('Project', portable),
  }
}

async function requiredRoot(
  source: IndependentReplicationRootSnapshotSource,
  entityType: 'AssetDefinition' | 'AssetBinding',
  originEntityId: string,
): Promise<IndependentReplicationRootSnapshot> {
  const value = await source.get(entityType, originEntityId)
  if (!value) {
    throw new Error(
      `Replication dependency missing: ${entityType}:${originEntityId}`,
    )
  }
  if (value.entityType !== entityType) {
    throw new Error(
      `Replication dependency type mismatch: expected ${entityType}, got ${value.entityType}`,
    )
  }
  return value
}

export async function generateIndependentRootReplicaGraph(
  input: IndependentRootReplicaGraphInput,
): Promise<IndependentRootReplicaGraphResult> {
  const graph = new CanonicalDependencyGraphBuilder({
    nodeId: input.nodeId,
    reader: input.dependencies,
    phase: input.phase,
    policy: input.policy,
    history: input.history,
  })
  const common = {
    nodeId: input.nodeId,
    phase: input.phase,
    policy: input.policy,
    history: input.history,
  } as const

  const emitAssetDefinition = async (assetId: string): Promise<void> => {
    if (graph.has('AssetDefinition', assetId)) return
    const snapshot = await requiredRoot(input.roots, 'AssetDefinition', assetId)
    if (snapshot.entityType !== 'AssetDefinition') {
      throw new Error(`AssetDefinition dependency mismatch: ${assetId}`)
    }
    const sharedIdentity = assetAssertion(snapshot.entity.upstreamIdentity)
    graph.emit(graph.dependency({
      ...common,
      entityType: 'AssetDefinition',
      originEntityId: snapshot.originEntityId,
      capturedAt: snapshot.changedAt,
      body: replicationBody(
        snapshot.entity as unknown as Readonly<Record<string, unknown>>,
      ),
      ...(sharedIdentity === undefined ? {} : { sharedIdentity }),
    }))
  }

  const emitAssetBinding = async (bindingId: string): Promise<void> => {
    if (graph.has('AssetBinding', bindingId)) return
    const snapshot = await requiredRoot(input.roots, 'AssetBinding', bindingId)
    if (snapshot.entityType !== 'AssetBinding') {
      throw new Error(`AssetBinding dependency mismatch: ${bindingId}`)
    }
    await emitAssetDefinition(snapshot.entity.assetId)
    await graph.emitInstallation(snapshot.entity.installationId)
    if (snapshot.entity.runtimeProfileId) {
      await graph.emitRuntimeProfile(snapshot.entity.runtimeProfileId)
    }
    graph.emit(graph.dependency({
      ...common,
      entityType: 'AssetBinding',
      originEntityId: snapshot.originEntityId,
      capturedAt: snapshot.changedAt,
      body: replicationBody(
        snapshot.entity as unknown as Readonly<Record<string, unknown>>,
      ),
      references: replicationRefs({
        assetDefinition: nodeEntityRef('AssetDefinition', snapshot.entity.assetId),
        installation: nodeEntityRef(
          'AgentInstallation',
          snapshot.entity.installationId,
        ),
        runtimeProfile: snapshot.entity.runtimeProfileId
          ? nodeEntityRef('RuntimeProfile', snapshot.entity.runtimeProfileId)
          : undefined,
      }),
    }))
  }

  let rootResult: ReturnType<typeof generateWireEntity> | undefined

  switch (input.root.entityType) {
    case 'AgentProduct': {
      const entity = input.root.entity
      rootResult = generateWireEntity({
        ...common,
        entityType: 'AgentProduct',
        originEntityId: entity.id,
        capturedAt: input.root.changedAt,
        body: replicationBody(entity as unknown as Readonly<Record<string, unknown>>),
      })
      break
    }

    case 'Host': {
      const entity = input.root.entity
      rootResult = generateWireEntity({
        ...common,
        entityType: 'Host',
        originEntityId: entity.id,
        capturedAt: input.root.changedAt,
        body: replicationBody(entity as unknown as Readonly<Record<string, unknown>>),
      })
      break
    }

    case 'AgentInstallation': {
      const entity = input.root.entity
      await graph.emitHost(entity.hostId)
      await graph.emitProduct(entity.productId)
      rootResult = generateWireEntity({
        ...common,
        entityType: 'AgentInstallation',
        originEntityId: entity.id,
        capturedAt: input.root.changedAt,
        body: replicationBody(entity as unknown as Readonly<Record<string, unknown>>),
        references: {
          host: nodeEntityRef('Host', entity.hostId),
          product: agentProductSharedRef(entity.productId),
        },
      })
      break
    }

    case 'RuntimeProfile': {
      const entity = input.root.entity
      await graph.emitInstallation(entity.installationId)
      rootResult = generateWireEntity({
        ...common,
        entityType: 'RuntimeProfile',
        originEntityId: entity.id,
        capturedAt: input.root.changedAt,
        body: replicationBody(entity as unknown as Readonly<Record<string, unknown>>),
        references: {
          installation: nodeEntityRef('AgentInstallation', entity.installationId),
        },
      })
      break
    }

    case 'Project': {
      const entity = input.root.entity
      const sharedIdentity = projectAssertion(entity.repositoryIdentity)
      rootResult = generateWireEntity({
        ...common,
        entityType: 'Project',
        originEntityId: entity.id,
        capturedAt: input.root.changedAt,
        body: replicationBody(entity as unknown as Readonly<Record<string, unknown>>),
        ...(sharedIdentity === undefined ? {} : { sharedIdentity }),
      })
      break
    }

    case 'Workspace': {
      const entity = input.root.entity
      await graph.emitHost(entity.hostId)
      if (entity.projectId) await graph.emitProject(entity.projectId)
      rootResult = generateWireEntity({
        ...common,
        entityType: 'Workspace',
        originEntityId: entity.id,
        capturedAt: input.root.changedAt,
        body: replicationBody(entity as unknown as Readonly<Record<string, unknown>>),
        references: replicationRefs({
          host: nodeEntityRef('Host', entity.hostId),
          project: entity.projectId
            ? nodeEntityRef('Project', entity.projectId)
            : undefined,
        }),
      })
      break
    }

    case 'LogicalSession': {
      const entity = input.root.entity
      await graph.emitInstallation(entity.installationId)
      if (entity.runtimeProfileId) {
        await graph.emitRuntimeProfile(entity.runtimeProfileId)
      }
      if (entity.projectId) await graph.emitProject(entity.projectId)
      if (entity.workspaceId) await graph.emitWorkspace(entity.workspaceId)
      rootResult = generateWireEntity({
        ...common,
        entityType: 'LogicalSession',
        originEntityId: entity.id,
        capturedAt: input.root.changedAt,
        body: replicationBody(entity as unknown as Readonly<Record<string, unknown>>),
        references: replicationRefs({
          installation: nodeEntityRef('AgentInstallation', entity.installationId),
          runtimeProfile: entity.runtimeProfileId
            ? nodeEntityRef('RuntimeProfile', entity.runtimeProfileId)
            : undefined,
          project: entity.projectId
            ? nodeEntityRef('Project', entity.projectId)
            : undefined,
          workspace: entity.workspaceId
            ? nodeEntityRef('Workspace', entity.workspaceId)
            : undefined,
        }),
      })
      break
    }

    case 'SourceSession': {
      const entity = input.root.entity
      await graph.emitInstallation(entity.installationId)
      if (entity.runtimeProfileId) {
        await graph.emitRuntimeProfile(entity.runtimeProfileId)
      }
      if (entity.logicalSessionId) {
        await graph.emitLogicalSession(entity.logicalSessionId)
      }
      rootResult = generateWireEntity({
        ...common,
        entityType: 'SourceSession',
        originEntityId: entity.id,
        capturedAt: input.root.changedAt,
        body: replicationBody(entity as unknown as Readonly<Record<string, unknown>>),
        references: replicationRefs({
          installation: nodeEntityRef('AgentInstallation', entity.installationId),
          runtimeProfile: entity.runtimeProfileId
            ? nodeEntityRef('RuntimeProfile', entity.runtimeProfileId)
            : undefined,
          logicalSession: entity.logicalSessionId
            ? nodeEntityRef('LogicalSession', entity.logicalSessionId)
            : undefined,
        }),
      })
      break
    }

    case 'SessionRelationship': {
      const entity = input.root.entity
      await graph.emitLogicalSession(entity.fromSessionId)
      await graph.emitLogicalSession(entity.toSessionId)
      for (const evidenceId of entity.evidenceRefs) {
        await graph.emitEvidence(evidenceId)
      }
      rootResult = generateWireEntity({
        ...common,
        entityType: 'SessionRelationship',
        originEntityId: entity.id,
        capturedAt: input.root.changedAt,
        body: replicationBody(entity as unknown as Readonly<Record<string, unknown>>),
        references: replicationRefs({
          fromSession: nodeEntityRef('LogicalSession', entity.fromSessionId),
          toSession: nodeEntityRef('LogicalSession', entity.toSessionId),
          evidence: entity.evidenceRefs.map(id => nodeEntityRef('Evidence', id)),
        }),
      })
      break
    }

    case 'AgentActor': {
      const entity = input.root.entity
      await graph.emitInstallation(entity.installationId)
      if (entity.logicalSessionId) {
        await graph.emitLogicalSession(entity.logicalSessionId)
      }
      if (entity.parentActorId) await graph.emitActor(entity.parentActorId)
      for (const evidenceId of entity.evidenceRefs) {
        await graph.emitEvidence(evidenceId)
      }
      rootResult = generateWireEntity({
        ...common,
        entityType: 'AgentActor',
        originEntityId: entity.id,
        capturedAt: input.root.changedAt,
        body: replicationBody(entity as unknown as Readonly<Record<string, unknown>>),
        references: replicationRefs({
          installation: nodeEntityRef('AgentInstallation', entity.installationId),
          logicalSession: entity.logicalSessionId
            ? nodeEntityRef('LogicalSession', entity.logicalSessionId)
            : undefined,
          parentActor: entity.parentActorId
            ? nodeEntityRef('AgentActor', entity.parentActorId)
            : undefined,
          evidence: entity.evidenceRefs.map(id => nodeEntityRef('Evidence', id)),
        }),
      })
      break
    }

    case 'SourceRecord': {
      const entity = input.root.entity
      await graph.emitInstallation(entity.installationId)
      rootResult = generateWireEntity({
        ...common,
        entityType: 'SourceRecord',
        originEntityId: entity.id,
        capturedAt: input.root.changedAt,
        body: replicationBody(entity as unknown as Readonly<Record<string, unknown>>),
        references: {
          installation: nodeEntityRef('AgentInstallation', entity.installationId),
        },
      })
      break
    }

    case 'Evidence': {
      const entity = input.root.entity
      if (entity.sourceRecordId) {
        await graph.emitSourceRecord(entity.sourceRecordId)
      }
      rootResult = generateWireEntity({
        ...common,
        entityType: 'Evidence',
        originEntityId: entity.id,
        capturedAt: input.root.changedAt,
        body: replicationBody(entity as unknown as Readonly<Record<string, unknown>>),
        references: replicationRefs({
          sourceRecord: entity.sourceRecordId
            ? nodeEntityRef('SourceRecord', entity.sourceRecordId)
            : undefined,
        }),
      })
      break
    }

    case 'Coverage': {
      const entity = input.root.entity
      for (const evidenceId of entity.evidenceRefs) {
        await graph.emitEvidence(evidenceId)
      }
      rootResult = generateWireEntity({
        ...common,
        entityType: 'Coverage',
        originEntityId: entity.id,
        capturedAt: input.root.changedAt,
        body: replicationBody(entity as unknown as Readonly<Record<string, unknown>>),
        references: replicationRefs({
          evidence: entity.evidenceRefs.map(id => nodeEntityRef('Evidence', id)),
        }),
      })
      break
    }

    case 'AssetDefinition': {
      const entity = input.root.entity
      const sharedIdentity = assetAssertion(entity.upstreamIdentity)
      rootResult = generateWireEntity({
        ...common,
        entityType: 'AssetDefinition',
        originEntityId: entity.id,
        capturedAt: input.root.changedAt,
        body: replicationBody(entity as unknown as Readonly<Record<string, unknown>>),
        ...(sharedIdentity === undefined ? {} : { sharedIdentity }),
      })
      break
    }

    case 'AssetBinding': {
      const entity = input.root.entity
      await emitAssetDefinition(entity.assetId)
      await graph.emitInstallation(entity.installationId)
      if (entity.runtimeProfileId) {
        await graph.emitRuntimeProfile(entity.runtimeProfileId)
      }
      rootResult = generateWireEntity({
        ...common,
        entityType: 'AssetBinding',
        originEntityId: entity.id,
        capturedAt: input.root.changedAt,
        body: replicationBody(entity as unknown as Readonly<Record<string, unknown>>),
        references: replicationRefs({
          assetDefinition: nodeEntityRef('AssetDefinition', entity.assetId),
          installation: nodeEntityRef('AgentInstallation', entity.installationId),
          runtimeProfile: entity.runtimeProfileId
            ? nodeEntityRef('RuntimeProfile', entity.runtimeProfileId)
            : undefined,
        }),
      })
      break
    }

    case 'AssetStateObservation': {
      const entity = input.root.entity
      await emitAssetBinding(entity.assetBindingId)
      for (const evidenceId of entity.evidenceRefs) {
        await graph.emitEvidence(evidenceId)
      }
      rootResult = generateWireEntity({
        ...common,
        entityType: 'AssetStateObservation',
        originEntityId: entity.id,
        capturedAt: input.root.changedAt,
        body: replicationBody(entity as unknown as Readonly<Record<string, unknown>>),
        references: replicationRefs({
          assetBinding: nodeEntityRef('AssetBinding', entity.assetBindingId),
          evidence: entity.evidenceRefs.map(id => nodeEntityRef('Evidence', id)),
        }),
      })
      break
    }

    case 'ToolDefinition': {
      const entity = input.root.entity
      if (entity.assetDefinitionId) {
        await emitAssetDefinition(entity.assetDefinitionId)
      }
      if (entity.installationId) {
        await graph.emitInstallation(entity.installationId)
      }
      rootResult = generateWireEntity({
        ...common,
        entityType: 'ToolDefinition',
        originEntityId: entity.id,
        capturedAt: input.root.changedAt,
        body: replicationBody(entity as unknown as Readonly<Record<string, unknown>>),
        references: replicationRefs({
          assetDefinition: entity.assetDefinitionId
            ? nodeEntityRef('AssetDefinition', entity.assetDefinitionId)
            : undefined,
          installation: entity.installationId
            ? nodeEntityRef('AgentInstallation', entity.installationId)
            : undefined,
        }),
      })
      break
    }
  }

  if (!rootResult) {
    throw new Error(`Unsupported Current-State Root type: ${input.root.entityType}`)
  }
  if (rootResult.kind === 'blocked') return rootResult
  graph.emit(rootResult.entity)
  return { kind: 'graph', entities: graph.entities }
}
