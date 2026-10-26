import type {IncomingMessage,ServerResponse} from 'node:http'
import type {CapturePolicyService,NativeSessionMetricsStore,SourceService} from '@agent-lens/core'
import {badRequest,writeJson} from './http-utils'

const PATH='/api/v1/native-sessions/metrics/overview'

/** SQL-only, Source-version-validated derived metrics. NEVER reads native bodies.
 * Native-only session ownership avoids double-counting legacy SQL Observations.
 */
export async function handleNativeSessionMetricsOverviewRequest(
  request:IncomingMessage,response:ServerResponse,url:URL,
  metrics?:NativeSessionMetricsStore,sources?:SourceService,policy?:CapturePolicyService,
  projectScopeReady=false,
):Promise<boolean>{
  if(url.pathname!==PATH)return false
  if(request.method!=='GET'){
    response.setHeader('allow','GET')
    writeJson(response,405,{error:'method_not_allowed'})
    return true
  }
  if(!metrics?.overview||!sources||!policy){
    writeJson(response,503,{state:'unavailable',reason:'native-metrics-overview-unavailable'})
    return true
  }
  if([...url.searchParams.keys()].some(key=>!['sourceId','installationId','projectId','from','to'].includes(key))
    || [...new Set([...url.searchParams.keys()])].some(key=>url.searchParams.getAll(key).length!==1)){
    throw badRequest('Invalid native metric overview parameters')
  }
  const sourceId=url.searchParams.get('sourceId')??''
  const installationId=url.searchParams.get('installationId')??''
  const projectId=url.searchParams.get('projectId')??''
  const from=url.searchParams.get('from')??''
  const to=url.searchParams.get('to')??''
  if((url.searchParams.has('sourceId')&&(!sourceId||sourceId.length>128))
    || (url.searchParams.has('installationId')&&(!installationId||installationId.length>512))
    || (url.searchParams.has('projectId')&&(!projectId||projectId.length>512))
    || (url.searchParams.has('from')&&!Number.isFinite(Date.parse(from)))
    || (url.searchParams.has('to')&&!Number.isFinite(Date.parse(to)))
    || (from&&to&&Date.parse(from)>Date.parse(to))){
    throw badRequest('Invalid native metric overview scope')
  }
  if(projectId&&!projectScopeReady){
    writeJson(response,200,{state:'unsupported',reason:'native-project-metrics-require-slim'})
    return true
  }
  const sourceDefs=sources.list()
    .filter(def=>policy.isSourceEnabled(def.manifest.sourceId)
      && (!sourceId||def.manifest.sourceId===sourceId))
  if(sourceDefs.length>32){
    writeJson(response,200,{state:'unsupported',reason:'native-metrics-sources-budget'})
    return true
  }
  const items=await Promise.all(sourceDefs.map(source=>metrics.overview!({
    sourceId:source.manifest.sourceId,
    parserVersion:source.manifest.parserVersion,
    coverageCertified:source.nativeSessionCoverageComplete===true,
    ...(installationId?{installationId}:{}),
    ...(projectId?{projectId}:{}),
    ...(from?{from}:{}),
    ...(to?{to}:{}),
  })))
  // Counts are exact only for full coverage of the current Source revisions.
  const complete=items.every(item=>
    item.eligibleSessions===item.readySessions && !item.toolsTruncated)
  writeJson(response,200,{
    state:'available',coverage:complete?'complete':'partial',items,
    totals:{
      eligibleSessions:items.reduce((n,item)=>n+item.eligibleSessions,0),
      readySessions:items.reduce((n,item)=>n+item.readySessions,0),
      missingSessions:items.reduce((n,item)=>n+item.missingSessions,0),
      staleSessions:items.reduce((n,item)=>n+item.staleSessions,0),
      partialSessions:items.reduce((n,item)=>n+item.partialSessions,0),
    },
  })
  return true
}
