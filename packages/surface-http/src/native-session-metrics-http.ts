import type { IncomingMessage, ServerResponse } from 'node:http'
import { NATIVE_SESSION_METRIC_PROJECTION_VERSION } from '@agent-lens/core'
import type {
  CapturePolicyService, NativeSessionCatalogEntry, NativeSessionCatalogStore,
  NativeSessionMetricSnapshot, NativeSessionMetricsStore, SourceDefinition,
  SourceService, SourceNativeSessionCursor,
} from '@agent-lens/core'
import { NativeSessionMetricAccumulator } from '@agent-lens/projection-usage'
import { badRequest, writeJson } from './http-utils'
import type { NativeSessionWindowReader } from './native-session-http'

const MAX_PAGES=64
const PAGE_LIMIT=32
const PROJECTION_VERSION=NATIVE_SESSION_METRIC_PROJECTION_VERSION
const PATH=/^\/api\/v1\/native-sessions\/([^/]+)\/metrics(?:\/(rebuild))?$/

export type NativeMetricRebuildResult =
  | {state:'available';coverage:'complete'|'partial';metricVersion:string;
     scannedObservations:number;reason:string|null;snapshot:NativeSessionMetricSnapshot}
  | {state:'drifted'|'unsupported'|'unavailable';reason:string}

/**
 * One bounded calculation shared by the explicit rebuild endpoint and lazy
 * on-demand scheduler. The Source Worker owns normalization, the Catalog owns
 * location, and only numeric snapshots cross into SQLite's existing Writer.
 */
export async function rebuildNativeSessionMetrics(
  entry:NativeSessionCatalogEntry,
  metrics:NativeSessionMetricsStore,
  reader:NativeSessionWindowReader,
  source:SourceDefinition,
  signal:AbortSignal,
):Promise<NativeMetricRebuildResult>{
  if(entry.locationKind!=='native'||!source.readNativeSessionPage){
    return {state:'unsupported',reason:'native-source-metrics-unavailable'}
  }
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
      return {state:'unsupported',reason:'native-metrics-source-boundaries-invalid'}
    }
    if(cursor && result.nextCursor.fileIdentity!==cursor.fileIdentity){
      return {state:'drifted',reason:'native-metrics-source-identity-changed'}
    }
    if(result.hasMore && cursor
      && result.nextCursor.offset===cursor.offset
      && result.nextCursor.sequence===cursor.sequence){
      return {state:'unsupported',reason:'native-metrics-source-cursor-not-advancing'}
    }
    for(const observation of result.observations)accumulator.add(observation)
    scannedRecords+=result.observations.length
    cursor=result.nextCursor
    pendingTail=result.pendingTail
    if(!result.hasMore){exhausted=true;break}
  }
  signal.throwIfAborted()
  // Codex/Claude/Hermes may contain Hook-only facts outside the native file.
  // Until Source-to-Hook correlation is certified, totals must stay partial.
  const hookNotCertified=['codex','claude-code','hermes'].includes(entry.sourceId)
  const snapshot=accumulator.snapshot({
    ...identity,fileIdentity:entry.fileIdentity,fileSize:entry.fileSize,
    fileMtimeMs:entry.fileMtimeMs,parserVersion:source.manifest.parserVersion,
    projectionVersion:PROJECTION_VERSION,computedAt:new Date().toISOString(),
    complete:exhausted&&!pendingTail&&!hookNotCertified,
  })
  if(!await metrics.replace(snapshot)){
    return {state:'drifted',reason:'native-metrics-catalog-revision-changed'}
  }
  return {
    state:'available',coverage:snapshot.coverage,metricVersion:snapshot.projectionVersion,
    scannedObservations:scannedRecords,
    reason:!exhausted?'native-metrics-page-budget'
      :pendingTail?'native-metrics-pending-tail'
        :hookNotCertified?'native-hook-coverage-unverified':null,
    snapshot,
  }
}

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
  if(!/^native:[0-9a-f]{32}$/.test(id))throw badRequest('Invalid native session identity')
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
  if(!rebuild){
    const current=await metrics.get(identity)
    const expected=sources?.list().find(x=>x.manifest.sourceId===entry.sourceId)?.manifest.parserVersion
    if(current.state==='available' && expected && current.snapshot.parserVersion!==expected){
      writeJson(response,200,{state:'stale',reason:'native-parser-version-changed'})
    }else if(current.state==='available' && current.snapshot.projectionVersion!==PROJECTION_VERSION){
      writeJson(response,200,{state:'stale',reason:'native-metrics-projection-version-changed'})
    }else writeJson(response,200,current)
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
  try{
    const output=await rebuildNativeSessionMetrics(entry,metrics,reader!,source,abort.signal)
    if(!abort.signal.aborted&&!response.destroyed)writeJson(response,200,output)
    return true
  }finally{
    response.off('close',onClose)
  }
}
