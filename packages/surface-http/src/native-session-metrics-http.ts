import type { IncomingMessage, ServerResponse } from 'node:http'
import { NATIVE_SESSION_METRIC_PROJECTION_VERSION } from '@agent-lens/core'
import type {
  CapturePolicyService, NativeSessionCatalogStore, NativeSessionMetricsStore,
  SourceService, SourceNativeSessionCursor, NativeSessionCatalogEntry, SourceDefinition,
} from '@agent-lens/core'
import { NativeSessionMetricAccumulator } from '@agent-lens/projection-usage'
import { badRequest, writeJson } from './http-utils'
import type { NativeSessionWindowReader } from './native-session-http'

const MAX_PAGES=64
const PAGE_LIMIT=32
const PROJECTION_VERSION=NATIVE_SESSION_METRIC_PROJECTION_VERSION
const PATH=/^\/api\/v1\/native-sessions\/([^/]+)\/metrics(?:\/(rebuild))?$/

export async function handleNativeSessionMetricsRequest(
  request:IncomingMessage,response:ServerResponse,url:URL,
  catalog?:NativeSessionCatalogStore,
  metrics?:NativeSessionMetricsStore,
  reader?:NativeSessionWindowReader,
  sources?:SourceService,
  policy?:CapturePolicyService,
):Promise<boolean>{
  const match=url.pathname.match(PATH)
  if(!match)return false
  const rebuild=match[2]==='rebuild'
  if(request.method!==(rebuild?'POST':'GET')){
    response.setHeader('allow',rebuild?'POST':'GET')
    writeJson(response,405,{error:'method_not_allowed'})
    return true
  }
  if(url.searchParams.size)throw badRequest('Native metric endpoint does not accept query fields')
  if(!catalog||!metrics||!policy||(rebuild&&(!reader||!sources))){
    writeJson(response,503,{state:'unavailable',reason:'native-metrics-unavailable'})
    return true
  }
  let id:string
  try{id=decodeURIComponent(match[1]!)}catch{throw badRequest('Invalid native session identity')}
  if(!id.startsWith('native:')||id.length>96)throw badRequest('Invalid native session identity')
  const entry=await catalog.getByReviewSessionId(id)
  if(!entry||!policy.isSourceEnabled(entry.sourceId)){
    writeJson(response,404,{error:'not_found'})
    return true
  }
  if(entry.locationKind!=='native'){
    writeJson(response,200,{state:'unsupported',reason:'native-metrics-archive-reader-unavailable'})
    return true
  }
  const identity={
    sourceId:entry.sourceId,installationId:entry.installationId,
    nativeSessionId:entry.nativeSessionId,
  }
  // Only sessions durably owned by Native-only may materialize metrics.
  // Legacy sessions continue to use their existing SQL projections without
  // a second, unused native scan or a misleading ready snapshot.
  if(!await catalog.hasNativeOnlyWriteClaim(identity)){
    writeJson(response,200,{state:'unsupported',reason:'native-metrics-legacy-session'})
    return true
  }
  const existing=await metrics.get(identity)
  if(!rebuild){
    // Do not claim the persisted Parser projection is current until checked.
    const expected=sources?.list().find(x=>x.manifest.sourceId===entry.sourceId)?.manifest.parserVersion
    if(existing.state==='available' && expected && existing.snapshot.parserVersion!==expected){
      writeJson(response,200,{state:'stale',reason:'native-parser-version-changed'})
    }else if(existing.state==='available' && existing.snapshot.projectionVersion!==PROJECTION_VERSION){
      writeJson(response,200,{state:'stale',reason:'native-metrics-projection-version-changed'})
    }else writeJson(response,200,existing)
    return true
  }
  const source=sources!.list().find(x=>x.manifest.sourceId===entry.sourceId)
  if(!source?.readNativeSessionPage){
    writeJson(response,200,{state:'unsupported',reason:'native-source-metrics-unavailable'})
    return true
  }
  const abort=new AbortController()
  const onClose=()=>{if(!response.writableEnded)abort.abort()}
  response.once('close',onClose)
  try {
    const output=await rebuildNativeSessionMetrics(entry,metrics,reader!,source,abort.signal)
    if(!abort.signal.aborted && !response.destroyed)writeJson(response,200,output)
    return true
  }catch(error){
    if(abort.signal.aborted || response.destroyed)return true
    throw error
  }finally{
    response.off('close',onClose)
  }
}


/** The single bounded computation path shared by explicit rebuild and
 * opportunistic refresh. The trusted Source Reader owns file authorization,
 * worker isolation and CapturePolicy; only numerical snapshots reach SQLite.
 */
export async function rebuildNativeSessionMetrics(
  entry:NativeSessionCatalogEntry,
  metrics:NativeSessionMetricsStore,
  reader:NativeSessionWindowReader,
  source:SourceDefinition,
  signal:AbortSignal,
){
  const identity={
    sourceId:entry.sourceId,installationId:entry.installationId,
    nativeSessionId:entry.nativeSessionId,
  }
  const accumulator=new NativeSessionMetricAccumulator()
  let cursor:SourceNativeSessionCursor|undefined
  let exhausted=false
  let pendingTail=false
  let scannedRecords=0
  for(let pageIndex=0;pageIndex<MAX_PAGES;pageIndex++){
    signal.throwIfAborted()
    const result=await reader.read({
      ...identity,limit:PAGE_LIMIT,signal,
      ...(cursor?{cursor}:{}),
    })
    signal.throwIfAborted()
    if(result.state!=='available')return result
    if(result.observations.length!==result.observationRecordIds.length){
      return {state:'unsupported' as const,reason:'native-metrics-source-boundaries-invalid'}
    }
    if(result.nextCursor.fileIdentity!==entry.fileIdentity){
      return {state:'drifted' as const,reason:'native-metrics-source-identity-changed'}
    }
    // Source-owned cursors must advance, even for the very first page.
    if(result.hasMore
      && result.nextCursor.offset===(cursor?.offset??0)
      && result.nextCursor.sequence===(cursor?.sequence??0)){
      return {state:'unsupported' as const,reason:'native-metrics-source-cursor-not-advancing'}
    }
    for(const observation of result.observations)accumulator.add(observation)
    scannedRecords+=result.observations.length
    cursor=result.nextCursor
    pendingTail=result.pendingTail
    if(!result.hasMore){exhausted=true;break}
  }
  signal.throwIfAborted()
  // EOF does not certify omitted runtime Hook facts or a mutable DB Source.
  // Until their full provenance/recovery contracts are proven, only Pi is
  // eligible for a complete numerical projection.
  const sourceCoverageCertified=entry.sourceId==='pi'
  const snapshot=accumulator.snapshot({
    ...identity,fileIdentity:entry.fileIdentity,fileSize:entry.fileSize,
    fileMtimeMs:entry.fileMtimeMs,parserVersion:source.manifest.parserVersion,
    projectionVersion:PROJECTION_VERSION,computedAt:new Date().toISOString(),
    complete:exhausted&&!pendingTail&&sourceCoverageCertified,
  })
  if(!await metrics.replace(snapshot)){
    return {state:'drifted' as const,reason:'native-metrics-catalog-revision-changed'}
  }
  return {
    state:'available' as const,
    coverage:snapshot.coverage,
    metricVersion:snapshot.projectionVersion,
    scannedObservations:scannedRecords,
    reason:!exhausted?'native-metrics-page-budget'
      :pendingTail?'native-metrics-pending-tail'
        :!sourceCoverageCertified?'native-source-coverage-unverified':null,
    snapshot,
  }
}
