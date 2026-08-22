import { AGENT_LENS_PROTOCOL_VERSION } from './timeline'

export type InsightConfidenceDto = 'exact' | 'high' | 'medium' | 'low' | 'unknown'

export interface InsightsQueryDto {
  sourceId?: string
  projectId?: string
  from?: string
  to?: string
}

export interface InsightMetricSetDto {
  sessionCount: number
  interactionCount: number
  toolCallCount: number
  errorCount: number
  totalDurationMs: number
}

export interface InsightTrendPointDto extends InsightMetricSetDto {
  date: string
}

export interface InsightAgentUsageDto extends InsightMetricSetDto {
  sourceId: string
  productIds: string[]
  observedAssetCallCount: number
}

export interface InsightAssetUsageDto {
  type: string
  canonicalName: string
  sourceIds: string[]
  callCount: number
  firstUsedAt: string
  lastUsedAt: string
  attribution: 'derived'
  confidence: InsightConfidenceDto
  observationIds: string[]
}

export interface InsightWorkflowPatternDto {
  key: string
  steps: string[]
  sessionCount: number
  occurrenceCount: number
  sampleSessionIds: string[]
  observationIds: string[]
  derivation: 'deterministic-sequence'
}

export interface InsightMetricDeltaDto {
  sessionCountPercent: number | null
  interactionCountPercent: number | null
  toolCallCountPercent: number | null
  errorCountPercent: number | null
  totalDurationMsPercent: number | null
}

export interface InsightPeriodComparisonDto {
  current: InsightMetricSetDto
  previous: InsightMetricSetDto
  delta: InsightMetricDeltaDto
  currentFrom: string
  currentTo: string
  previousFrom: string
  previousTo: string
}

export interface InsightsResponseDto {
  summary: InsightMetricSetDto
  trend: InsightTrendPointDto[]
  agents: InsightAgentUsageDto[]
  assets: InsightAssetUsageDto[]
  workflowPatterns: InsightWorkflowPatternDto[]
  comparison?: InsightPeriodComparisonDto
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    generatedAt: string
    from?: string
    to?: string
    sampled: boolean
    sessionSampleLimit: number
    workflowPatternMinimumSessions: number
    notes: string[]
  }
}
