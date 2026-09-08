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
  toolName?: string
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

export interface ToolUsageWorkflowPatternQuery {
  projectId?: ProjectId
  sourceId?: string
  from?: string
  to?: string
  minimumSessions: number
  patternLimit: number
  sessionSampleLimit: number
  observationSampleLimit: number
}

export interface ToolUsageWorkflowPatternRecord {
  key: string
  steps: string[]
  sessionCount: number
  occurrenceCount: number
  sampleSessionIds: LogicalSessionId[]
  observationIds: ObservationId[]
}

/** Deterministic workflow taxonomy shared by portable and storage-side aggregators. */
export function toolUsageWorkflowCategory(nativeName: string): string {
  const lower = nativeName.toLowerCase()
  const mcp = lower.match(/^mcp__(.+?)__(.+)$/)
  if (mcp?.[1]) return `MCP：${mcp[1]}`
  if (lower === 'skill') return '技能调用'
  if (/(^|[_-])(read|cat|view|open)([_-]|$)/.test(lower)) return '读取文件'
  if (/(^|[_-])(write|edit|patch|apply)([_-]|$)/.test(lower)) return '修改文件'
  if (/(^|[_-])(grep|search|find|glob|list)([_-]|$)/.test(lower)) return '搜索定位'
  if (/(^|[_-])(bash|shell|exec|terminal|command|run)([_-]|$)/.test(lower)) return '命令执行'
  if (/(^|[_-])(web|http|fetch|browser)([_-]|$)/.test(lower)) return '网络访问'
  return nativeName
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
  /** Exact asset totals partitioned by source, for source-oriented surfaces. */
  aggregateAssetsBySource?(input: ToolUsageAggregateQuery): Promise<ToolUsageAggregateAssetRecord[]>
  /** Exact workflow n-gram summaries derived from the incrementally maintained Tool Fact layer. */
  workflowPatterns?(input: ToolUsageWorkflowPatternQuery): Promise<ToolUsageWorkflowPatternRecord[]>
}
