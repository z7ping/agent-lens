import {
  AGENT_LENS_PROTOCOL_VERSION,
  type NativeMetricContributionDto,
  type ToolAssetUsageResponseDto,
  type InsightsResponseDto,
} from '@agent-lens/protocol'

/** Reuses the existing HTTP response envelope during cutover without
 * creating fake Legacy Observation rows. `mode:native-only` is mandatory:
 * clients MUST ignore the protocol's legacy-only placeholder counters and
 * use meta.native's verified numeric totals/coverage instead.
 */
export function nativeOnlyToolUsageResponse(
  native:NativeMetricContributionDto,
):ToolAssetUsageResponseDto {
  return {
    tools:[],assets:[],
    meta:{
      protocolVersion:AGENT_LENS_PROTOCOL_VERSION,
      mode:'native-only',
      toolCount:0,assetCount:0,unattributedToolCalls:0,hasMoreTools:false,
      native,
      generatedAt:new Date().toISOString(),
    },
  }
}

export function nativeOnlyInsightsResponse(
  native:NativeMetricContributionDto,
  scope:{from?:string;to?:string},
):InsightsResponseDto {
  const placeholder={
    sessionCount:0,interactionCount:0,toolCallCount:0,errorCount:0,totalDurationMs:0,
  }
  return {
    // These arrays and fields belong to retired Legacy per-event projections.
    // They are intentionally empty, NOT verified zero measurements.
    summary:placeholder,
    trend:[],agents:[],assets:[],workflowPatterns:[],
    meta:{
      protocolVersion:AGENT_LENS_PROTOCOL_VERSION,
      mode:'native-only',
      generatedAt:new Date().toISOString(),
      ...(scope.from?{from:scope.from}:{}),
      ...(scope.to?{to:scope.to}:{}),
      sampled:false,sessionSampleLimit:0,workflowPatternMinimumSessions:5,
      notes:[
        'native-only: legacy summary/trend/workflow arrays are not applicable',
        'Only meta.native contains independently verified original-source counts; duration and per-event patterns are unavailable',
      ],
      native,
    },
  }
}
