import type {
  AgentInstallationId,
  AgentProductId,
  JsonValue,
  LogicalSessionId,
  ObservationId,
  ProjectId,
} from '../domain/common'
import type { ObservationCursor } from './index'

export type ToolUsageObservationKind = 'tool.call' | 'tool.result'

export interface ToolUsageObservationRecord {
  id: ObservationId
  installationId: AgentInstallationId
  logicalSessionId: LogicalSessionId
  projectId?: ProjectId
  sourceId: string
  productId: AgentProductId
  kind: ToolUsageObservationKind
  sourceSequence?: number
  canonicalSequence?: number
  occurredAt?: string
  capturedAt: string
  payload: JsonValue
}

export interface ToolUsageObservationQuery {
  kind: ToolUsageObservationKind
  installationId?: AgentInstallationId
  logicalSessionId?: LogicalSessionId
  projectId?: ProjectId
  sourceId?: string
  from?: string
  to?: string
  after?: ObservationCursor
  limit?: number
}

/**
 * Narrow read-only storage contract for usage projections.
 * It deliberately excludes Evidence and unrelated Observation fields so
 * analytical reads do not materialize canonical data they never consume.
 */
export interface ToolUsageObservationReader {
  query(input: ToolUsageObservationQuery): Promise<ToolUsageObservationRecord[]>
}
