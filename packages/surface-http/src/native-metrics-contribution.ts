import type {
  CapturePolicyService, NativeSessionMetricsStore, SourceService,
} from '@agent-lens/core'
import type { NativeMetricContributionDto } from '@agent-lens/protocol'

export interface NativeContributionScope {
  sourceIds?:readonly string[]
  sourceId?:string
  installationId?:string
  projectId?:string
  logicalSessionId?:string
  toolName?:string
  from?:string
  to?:string
  /** Opt-in per-tool numbers for Usage only; Insights remains compact. */
  includeTools?:boolean
}

/** SQL-only Native-only contribution to the EXISTING Usage/Insights DTO.
 * It remains separate from the legacy event totals until all dimension
 * contracts (project, asset, session durations) are reconciled.
 */
export async function nativeMetricContribution(
  metrics:NativeSessionMetricsStore|undefined,
  sources:SourceService|undefined,
  policy:CapturePolicyService|undefined,
  scope:NativeContributionScope,
):Promise<NativeMetricContributionDto>{
  if(scope.projectId || scope.logicalSessionId || scope.toolName){
    return {state:'unsupported',reason:'native-metrics-filter-not-indexed'}
  }
  if(!metrics?.overview||!sources||!policy){
    return {state:'unavailable',reason:'native-metrics-contribution-unavailable'}
  }
  const selected=scope.sourceIds ?? (scope.sourceId?[scope.sourceId]:undefined)
  if(selected?.length===0){
    return {state:'available',coverage:'complete',eligibleSessions:0,readySessions:0,
      missingSessions:0,staleSessions:0,partialSessions:0,
      interactionCount:0,toolCallCount:0,errorCount:0,inputTokens:null,outputTokens:null,
      ...(scope.includeTools?{tools:[],toolsTruncated:false}:{}),}
  }
  const ids=new Set(selected)
  const defs=sources.list().filter(source=>
    (!selected || ids.has(source.manifest.sourceId))
    && policy.isSourceEnabled(source.manifest.sourceId))
  if(selected && defs.length!==ids.size){
    // A selected disabled, unknown, or not-yet-discovered Source is NOT a
    // verified empty dataset; pretending complete would conceal a gap.
    return {state:'unsupported',reason:'native-metrics-source-scope-unavailable'}
  }
  if(defs.length>32){
    return {state:'unsupported',reason:'native-metrics-sources-budget'}
  }
  try{
    const chunks=await Promise.all(defs.map(source=>metrics.overview!({
      sourceId:source.manifest.sourceId,parserVersion:source.manifest.parserVersion,
      coverageCertified:source.nativeSessionCoverageComplete===true,
      ...(scope.installationId?{installationId:scope.installationId}:{}),
      ...(scope.from?{from:scope.from}:{}),...(scope.to?{to:scope.to}:{}),
    })))
    const sum=(key:'eligibleSessions'|'readySessions'|'missingSessions'|'staleSessions'|'partialSessions')=>
      chunks.reduce((total,item)=>total+item[key],0)
    const ready=sum('readySessions')
    const total=(key:'interactionCount'|'toolCallCount'|'errorCount')=>
      chunks.reduce((value,item)=>value+item.totals[key],0)
    const tokens=(key:'inputTokens'|'outputTokens'):number|null=>
      ready===0||chunks.some(item=>item.readySessions>0 && item.totals[key]===null)
        ?null
        :chunks.reduce((value,item)=>value+(item.totals[key]??0),0)
    const eligible=sum('eligibleSessions')
    // Keep distinct Source identities; never invent ToolUsageDto success rates,
    // event IDs, session links or durations from aggregate-only records.
    const rawTools=scope.includeTools
      ?chunks.flatMap(item=>item.tools.map(tool=>({
        sourceId:item.sourceId,nativeToolName:tool.nativeToolName,
        callCount:tool.callCount,resultCount:tool.resultCount,
        errorCount:tool.errorCount,sessionCount:tool.sessionCount,
      })))
      :[]
    rawTools.sort((a,b)=>b.callCount-a.callCount
      || a.sourceId.localeCompare(b.sourceId)
      || a.nativeToolName.localeCompare(b.nativeToolName))
    const toolsTruncated=rawTools.length>256 || chunks.some(item=>item.toolsTruncated)
    return {
      state:'available',
      coverage:eligible===ready && !toolsTruncated?'complete':'partial',
      eligibleSessions:eligible,readySessions:ready,
      missingSessions:sum('missingSessions'),staleSessions:sum('staleSessions'),
      partialSessions:sum('partialSessions'),
      interactionCount:total('interactionCount'),toolCallCount:total('toolCallCount'),
      errorCount:total('errorCount'),inputTokens:tokens('inputTokens'),
      outputTokens:tokens('outputTokens'),
      ...(scope.includeTools?{
        tools:rawTools.slice(0,256),toolsTruncated,
      }:{}),
    }
  }catch{
    // Legacy endpoints must remain useful if the Native metrics table/worker
    // is unavailable. Never return a forged zero for a failed native query.
    return {state:'unavailable',reason:'native-metrics-contribution-query-failed'}
  }
}
