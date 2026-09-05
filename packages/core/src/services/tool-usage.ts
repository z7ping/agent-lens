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

export interface ToolUsageAggregateQuery {
  installationId?: AgentInstallationId
  logicalSessionId?: LogicalSessionId
  projectId?: ProjectId
  sourceId?: string
  from?: string
  to?: string
  /** Maximum number of evidence/session detail samples returned per aggregate row. */
  detailLimit: number
}

export interface ToolUsageAggregateSession {
  logicalSessionId: LogicalSessionId
  callCount: number
  /** Known failures of this specific tool in the session. */
  errorCount?: number
  /** Human-readable task title derived from canonical/native session facts. */
  title?: string
  projectName?: string
  workspacePath?: string
  endedAt?: string
}

export interface ToolUsageAggregateToolRecord {
  nativeToolName: string
  sourceIds: string[]
  productIds: AgentProductId[]
  callCount: number
  resultCount: number
  successCount: number
  errorCount: number
  sessionCount: number
  sessions: ToolUsageAggregateSession[]
  totalDurationMs: number
  firstUsedAt: string
  lastUsedAt: string
  observationIds: ObservationId[]
}

export interface ToolUsageAggregateAssetRecord {
  type: 'mcp' | 'skill'
  canonicalName: string
  sourceIds: string[]
  callCount: number
  firstUsedAt: string
  lastUsedAt: string
  observationIds: ObservationId[]
}

export interface ToolUsageAggregateResult {
  tools: ToolUsageAggregateToolRecord[]
  assets: ToolUsageAggregateAssetRecord[]
  unattributedToolCalls: number
}

/**
 * Narrow read-only storage contract for usage projections.
 * It deliberately excludes Evidence and unrelated Observation fields so
 * analytical reads do not materialize canonical data they never consume.
 *
 * Storage implementations may optionally provide aggregate(). Projections
 * should prefer it for large analytical ranges and retain query() as the
 * portable fallback for stores that cannot aggregate natively.
 */
export interface ToolUsageObservationReader {
  query(input: ToolUsageObservationQuery): Promise<ToolUsageObservationRecord[]>
  aggregate?(input: ToolUsageAggregateQuery): Promise<ToolUsageAggregateResult>
}
