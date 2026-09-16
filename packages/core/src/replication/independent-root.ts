import type {
  AssetBinding,
  AssetDefinition,
  AssetStateObservation,
  ToolDefinition,
} from '../domain/assets'
import type { SessionRelationship } from '../domain/identity'
import type { ObservationCoverage } from '../domain/observation'
import type { IndependentReplicationRootEntityType } from './types'

export type IndependentReplicationRootEntity =
  | { entityType: 'SessionRelationship'; entity: SessionRelationship }
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
  latestRevision: number
  changedAt: string
}

export type IndependentReplicationRootSnapshot =
  | (IndependentReplicationRootSnapshotBase<'SessionRelationship'> & {
      entity: SessionRelationship
    })
  | (IndependentReplicationRootSnapshotBase<'Coverage'> & {
      entity: ObservationCoverage
    })
  | (IndependentReplicationRootSnapshotBase<'AssetDefinition'> & {
      entity: AssetDefinition
    })
  | (IndependentReplicationRootSnapshotBase<'AssetBinding'> & {
      entity: AssetBinding
    })
  | (IndependentReplicationRootSnapshotBase<'AssetStateObservation'> & {
      entity: AssetStateObservation
    })
  | (IndependentReplicationRootSnapshotBase<'ToolDefinition'> & {
      entity: ToolDefinition
    })

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
