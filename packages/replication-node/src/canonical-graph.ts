import type { CanonicalObservation } from '@agent-lens/core'
import type {
  HistoryBoundary,
  ReplicationHistoryPhase,
  ReplicationPolicy,
} from '@agent-lens/core/replication'
import type { WireEntityEnvelope } from '@agent-lens/protocol/replication'
import {
  CanonicalDependencyGraphBuilder,
  canonicalReplicationReaderFromRepositories,
  replicationBody,
  replicationRefs,
  type CanonicalReplicationReader,
} from './canonical-dependency-graph'
import {
  generateWireEntity,
  nodeEntityRef,
} from './entity-generator'

export {
  CanonicalDependencyGraphBuilder,
  canonicalReplicationReaderFromRepositories,
  replicationBody,
  replicationRefs,
  type CanonicalReplicationReader,
} from './canonical-dependency-graph'

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

export async function generateObservationReplicaGraph(
  input: ObservationReplicaGraphInput,
): Promise<ObservationReplicaGraphResult> {
  const common = {
    nodeId: input.nodeId,
    phase: input.phase,
    policy: input.policy,
    history: input.history,
  } as const

  const root = generateWireEntity({
    ...common,
    entityType: 'CanonicalObservation',
    originEntityId: input.observation.id,
    capturedAt: input.observation.capturedAt,
    body: replicationBody(
      input.observation as unknown as Readonly<Record<string, unknown>>,
    ),
    references: replicationRefs({
      host: nodeEntityRef('Host', input.observation.hostId),
      installation: nodeEntityRef('AgentInstallation', input.observation.installationId),
      project: input.observation.projectId
        ? nodeEntityRef('Project', input.observation.projectId)
        : undefined,
      workspace: input.observation.workspaceId
        ? nodeEntityRef('Workspace', input.observation.workspaceId)
        : undefined,
      logicalSession: nodeEntityRef(
        'LogicalSession',
        input.observation.logicalSessionId,
      ),
      sourceSession: nodeEntityRef('SourceSession', input.observation.sourceSessionId),
      actor: input.observation.actorId
        ? nodeEntityRef('AgentActor', input.observation.actorId)
        : undefined,
      evidence: input.observation.evidenceRefs.map(id =>
        nodeEntityRef('Evidence', id),
      ),
    }),
  })
  if (root.kind === 'blocked') return root

  const graph = new CanonicalDependencyGraphBuilder({
    nodeId: input.nodeId,
    reader: input.reader,
    phase: input.phase,
    policy: input.policy,
    history: input.history,
  })

  await graph.emitHost(input.observation.hostId)
  await graph.emitInstallation(input.observation.installationId)
  if (input.observation.projectId) await graph.emitProject(input.observation.projectId)
  if (input.observation.workspaceId) {
    await graph.emitWorkspace(input.observation.workspaceId)
  }
  await graph.emitLogicalSession(input.observation.logicalSessionId)
  await graph.emitSourceSession(input.observation.sourceSessionId)
  if (input.observation.actorId) await graph.emitActor(input.observation.actorId)
  for (const evidenceId of input.observation.evidenceRefs) {
    await graph.emitEvidence(evidenceId)
  }

  graph.emit(root.entity)
  return { kind: 'graph', entities: graph.entities }
}
