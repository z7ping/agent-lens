import type { AssetBindingId, CoverageId, ObservationId } from '../domain/common'

export interface CoreEventMap {
  'source/registered': { sourceId: string }
  'source/detected': { sourceId: string; installationId?: string }
  'source-record/received': { sourceId: string; sourceRecordId: string }
  'observation/committed': { observationId: ObservationId }
  'coverage/changed': { coverageId: CoverageId }
  'asset/changed': { assetBindingId: AssetBindingId }
  'projection/invalidated': { projectionId: string }
  'projection/rebuilt': { projectionId: string }
}
