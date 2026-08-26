import type { AssetBindingId, CoverageId, LogicalSessionId, ObservationId } from '../domain/common'

export interface CoreEventMap {
  'source/registered': { sourceId: string }
  'source/detected': { sourceId: string; installationId?: string }
  'source-record/received': { sourceId: string; sourceRecordId: string }
  'observation/committed': {
    observationId: ObservationId
    logicalSessionId: LogicalSessionId
    status: 'created' | 'merged'
  }
  'coverage/changed': { coverageId: CoverageId }
  'asset/changed': { assetBindingId: AssetBindingId }
  'projection/invalidated': { projectionId: string; subjectType?: string; subjectId?: string }
  'projection/rebuilt': { projectionId: string; subjectType?: string; subjectId?: string }
}
