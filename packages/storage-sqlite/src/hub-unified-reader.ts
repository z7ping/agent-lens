import type {
  JsonValue,
  LogicalSession,
  SessionRepository,
} from '@agent-lens/core'
import type {
  ReplicationAvailability,
} from '@agent-lens/core/replication'
import type { HubRemoteReadEntity } from './hub-remote-reader'

export type HubUnifiedReadOrigin =
  | {
      kind: 'local'
      nodeId: string
      entityId: string
    }
  | {
      kind: 'remote'
      nodeId: string
      entityId: string
      generationId: string
    }

export interface HubUnifiedLogicalSession {
  publicId: string
  entityType: 'LogicalSession'
  origin: HubUnifiedReadOrigin
  body: Readonly<Record<string, ReplicationAvailability>>
}

export interface HubRemoteReadPort {
  get(publicId: string): Promise<HubRemoteReadEntity | undefined>
}

function availability(value: JsonValue | undefined): ReplicationAvailability {
  if (value === undefined) return { state: 'omitted', reason: 'not-captured' }
  if (value === null) return { state: 'null' }
  return { state: 'value', value }
}

function localSessionBody(session: LogicalSession): Readonly<Record<string, ReplicationAvailability>> {
  return {
    id: availability(session.id),
    installationId: availability(session.installationId),
    runtimeProfileId: availability(session.runtimeProfileId),
    projectId: availability(session.projectId),
    workspaceId: availability(session.workspaceId),
    title: availability(session.title),
    startedAt: availability(session.startedAt),
    endedAt: availability(session.endedAt),
  }
}

function remoteSessionBody(entity: HubRemoteReadEntity): Readonly<Record<string, ReplicationAvailability>> {
  if (!entity.body || Array.isArray(entity.body) || typeof entity.body !== 'object') {
    throw new TypeError('Remote LogicalSession body must be an availability object')
  }
  return entity.body as unknown as Readonly<Record<string, ReplicationAvailability>>
}

/**
 * First H8 Unified Read slice.
 *
 * It composes Local Canonical LogicalSession with the formal active-generation
 * Remote Replica read boundary. Local Canonical IDs stay unchanged, while
 * remote entities are addressed only by ReplicaKey. Projection/Web callers do
 * not inspect Hub replica tables or generation state themselves.
 */
export class HubUnifiedLogicalSessionReader {
  constructor(
    private readonly localNodeId: string,
    private readonly localSessions: SessionRepository,
    private readonly remote: HubRemoteReadPort,
  ) {}

  async get(publicId: string): Promise<HubUnifiedLogicalSession | undefined> {
    const local = await this.localSessions.getLogicalSession(publicId as LogicalSession['id'])
    if (local) {
      return {
        publicId: local.id,
        entityType: 'LogicalSession',
        origin: {
          kind: 'local',
          nodeId: this.localNodeId,
          entityId: local.id,
        },
        body: localSessionBody(local),
      }
    }

    const remote = await this.remote.get(publicId)
    if (!remote || remote.entityType !== 'LogicalSession') return undefined
    return {
      publicId: remote.publicId,
      entityType: 'LogicalSession',
      origin: {
        kind: 'remote',
        nodeId: remote.originNodeId,
        entityId: remote.originEntityId,
        generationId: remote.generationId,
      },
      body: remoteSessionBody(remote),
    }
  }
}
