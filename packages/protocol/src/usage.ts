import { AGENT_LENS_PROTOCOL_VERSION } from './timeline'

export type UsageAttribution = 'derived'
export type UsageConfidence = 'high' | 'medium' | 'low'
export type UsageAssetType = 'mcp' | 'skill'

export interface ToolUsageDto {
  nativeToolName: string
  sourceIds: string[]
  productIds: string[]
  callCount: number
  resultCount: number
  successCount: number
  errorCount: number
  totalDurationMs: number
  firstUsedAt: string
  lastUsedAt: string
  observationIds: string[]
}

export interface AssetUsageDto {
  type: UsageAssetType
  canonicalName: string
  sourceIds: string[]
  callCount: number
  firstUsedAt: string
  lastUsedAt: string
  attribution: UsageAttribution
  confidence: UsageConfidence
  observationIds: string[]
}

export interface ToolAssetUsageQueryDto {
  installationId?: string
  logicalSessionId?: string
  limit?: number
}

export interface ToolAssetUsageResponseDto {
  tools: ToolUsageDto[]
  assets: AssetUsageDto[]
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    toolCount: number
    assetCount: number
    unattributedToolCalls: number
    hasMoreTools: boolean
    generatedAt: string
  }
}
