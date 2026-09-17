import type {
  AssetBinding,
  AssetDefinition,
  AssetStateObservation,
  ToolDefinition,
} from '../domain/assets'
import type {
  AgentActor,
  AgentInstallation,
  AgentProduct,
  Host,
  LogicalSession,
  Project,
  RuntimeProfile,
  SessionRelationship,
  SourceSession,
  Workspace,
} from '../domain/identity'
import type {
  Evidence,
  ObservationCoverage,
  SourceRecord,
} from '../domain/observation'
import type { IndependentReplicationRootEntityType } from './types'

export type IndependentReplicationRootEntity =
  | { entityType: 'AgentProduct'; entity: AgentProduct }
  | { entityType: 'Host'; entity: Host }
  | { entityType: 'AgentInstallation'; entity: AgentInstallation }
  | { entityType: 'RuntimeProfile'; entity: RuntimeProfile }
  | { entityType: 'Project'; entity: Project }
  | { entityType: 'Workspace'; entity: Workspace }
  | { entityType: 'LogicalSession'; entity: LogicalSession }
  | { entityType: 'SourceSession'; entity: SourceSession }
  | { entityType: 'SessionRelationship'; entity: SessionRelationship }
  | { entityType: 'AgentActor'; entity: AgentActor }
  | { entityType: 'SourceRecord'; entity: SourceRecord }
  | { entityType: 'Evidence'; entity: Evidence }
  | { entityType: 'Coverage'; entity: ObservationCoverage }
  | { entityType: 'AssetDefinition'; entity: AssetDefinition }
  | { entityType: 'AssetBinding'; entity: AssetBinding }
  | { entityType: 'AssetStateObservation'; entity: AssetStateObservation }
  | { entityType: 'ToolDefinition'; entity: ToolDefinition }

export interface IndependentReplicationRootSnapshotBase<
  TEntityType extends IndependentReplicationRootEntityType =
    IndependentReplicationRootEntityType,
> {
  entityType: TEntityType
  originEntityId: string
  firstRevision: number
  firstChangedAt: string
  latestRevision: number
  latestChangedAt: string
  historyCapturedAt: string
}

type EntityFor<TEntityType extends IndependentReplicationRootEntityType> =
  Extract<IndependentReplicationRootEntity, { entityType: TEntityType }>['entity']

export type IndependentReplicationRootSnapshot = {
  [TEntityType in IndependentReplicationRootEntityType]:
    IndependentReplicationRootSnapshotBase<TEntityType> & {
      entity: EntityFor<TEntityType>
    }
}[IndependentReplicationRootEntityType]

export interface IndependentReplicationRootSnapshotPage {
  items: readonly IndependentReplicationRootSnapshot[]
  nextCursor?: string
  done: boolean
}

export interface IndependentReplicationRootSnapshotSource {
  scan(input: {
    entityType: IndependentReplicationRootEntityType
    afterId?: string
    changedAtOnOrAfter?: string
    limit?: number
  }): Promise<IndependentReplicationRootSnapshotPage>

  get(
    entityType: IndependentReplicationRootEntityType,
    originEntityId: string,
  ): Promise<IndependentReplicationRootSnapshot | null>
}
