import type { IncomingMessage, ServerResponse } from 'node:http'
import { stat } from 'node:fs/promises'
import { NATIVE_SESSION_METRIC_PROJECTION_VERSION } from '@agent-lens/core'
import type {
  CapturePolicyService, NativeSessionCatalogStore, NativeSessionMetricsStore,
  SourceService, SourceNativeSessionCursor, NativeSessionCatalogEntry, SourceDefinition,
} from '@agent-lens/core'
import { NativeSessionMetricAccumulator } from '@agent-lens/projection-usage'
import { nativeSqliteRevision } from '@agent-lens/source-support'
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
  // On slim-only SQLite, verified Native Catalog presence is sufficient
  // for eligible on-demand numerical computation; there is no write-claim
  // table. Older v38 databases still use ownership to avoid double counts.
  const eligible = catalog.isNativeMetricsEligible
    ? await catalog.isNativeMetricsEligible(identity)
    : await catalog.hasNativeOnlyWriteClaim(identity)
  if(!eligible){
    writeJson(response,200,{state:'unsupported',reason:'native-metrics-legacy-session'})
    return true
  }
  const existing=await metrics.get(identity)
  if(!rebuild){
    // Do not claim the persisted Parser projection is current until checked.
    const expected=sources?.list().find(x=>x.manifest.sourceId===entry.sourceId)?.manifest.parserVersion
    const source=sources?.list().find(x=>x.manifest.sourceId===entry.sourceId)
    if(existing.state==='available' && existing.snapshot.coverage==='complete'
      && source?.nativeSessionCoverageComplete!==true){
      writeJson(response,200,{state:'stale',reason:'native-source-coverage-unverified'})
    }else if(existing.state==='available' && expected && existing.snapshot.parserVersion!==expected){
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


/** Resume state is memory-only and scoped to one verified source revision.
 * Tool call IDs used by the accumulator never enter SQLite or HTTP DTOs. */
export interface NativeMetricRebuildProgress {
  reviewSessionId:string
  sourceId:string; installationId:string; nativeSessionId:string
  fileIdentity:string; fileSize:number; fileMtimeMs:number; parserVersion:string
  accumulator:NativeSessionMetricAccumulator
  cursor:SourceNativeSessionCursor
  scannedRecords:number
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
  incremental?:{enabled:true;progress?:NativeMetricRebuildProgress;reviewSessionId?:string},
){
  const identity={
    sourceId:entry.sourceId,installationId:entry.installationId,
    nativeSessionId:entry.nativeSessionId,
  }
  const reviewSessionId=incremental?.reviewSessionId ?? incremental?.progress?.reviewSessionId
  if(incremental && (!reviewSessionId || !reviewSessionId.startsWith('native:') || reviewSessionId.length>96)){
    return {state:'unsupported' as const,reason:'native-metrics-resume-session-id-missing'}
  }
  const prior=incremental?.progress
  const reusable=prior && prior.sourceId===entry.sourceId
    && prior.installationId===entry.installationId
    && prior.nativeSessionId===entry.nativeSessionId
    && prior.fileIdentity===entry.fileIdentity
    && prior.fileSize===entry.fileSize
    && prior.fileMtimeMs===entry.fileMtimeMs
    && prior.parserVersion===source.manifest.parserVersion
  const accumulator=reusable && prior?prior.accumulator:new NativeSessionMetricAccumulator()
  let cursor:SourceNativeSessionCursor|undefined=reusable && prior?prior.cursor:undefined
  let exhausted=false
  let pendingTail=false
  let scannedRecords=reusable && prior?prior.scannedRecords:0
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
  // The bounded reader may not yet have reached EOF. Retain only numeric
  // accumulator state and the verified Source-owned cursor in ephemeral memory.
  // No partial/incorrect full-session snapshot is written to SQLite here.
  if(incremental && !exhausted){
    if(!cursor) return {state:'unsupported' as const,
      reason:'native-metrics-resume-cursor-missing'}
    return {state:'in_progress' as const,progress:{
      reviewSessionId:reviewSessionId!,
      ...identity,fileIdentity:entry.fileIdentity,fileSize:entry.fileSize,
      fileMtimeMs:entry.fileMtimeMs,parserVersion:source.manifest.parserVersion,
      accumulator,cursor,scannedRecords,
    } satisfies NativeMetricRebuildProgress}
  }
  // Native SQLite can change entirely in -wal while the main database
  // mtime/size and inode remain unchanged. A reader cursor proves a local
  // snapshot, not that the entire multi-page scan came from one revision.
  // Check the actual source revision before publishing numerical totals.
  if (/\.(?:db|sqlite)$/i.test(entry.filePath)) {
    let current: Awaited<ReturnType<typeof nativeSqliteRevision>>
    try { current=await nativeSqliteRevision(entry.filePath) }
    catch {
      return {state:'unavailable' as const,reason:'native-metrics-source-revision-unavailable'}
    }
    signal.throwIfAborted()
    if (current.fileIdentity!==entry.fileIdentity
      || current.fileSize!==entry.fileSize
      || current.fileMtimeMs!==entry.fileMtimeMs) {
      return {state:'drifted' as const,reason:'native-metrics-source-revision-changed'}
    }
  }
  // JSONL can append or rotate during a multi-page scan while Catalog
  // metadata lags. Cursors certify the opened inode, not a stable EOF size.
  // Certified production file Sources provide original rawRecovery.verify;
  // they must confirm the actual current revision before claiming totals.
  if (/\.jsonl$/i.test(entry.filePath) && source.rawRecovery?.verify) {
    let current:Awaited<ReturnType<typeof stat>>
    try{current=await stat(entry.filePath)}
    catch{
      return {state:'unavailable' as const,reason:'native-metrics-source-revision-unavailable'}
    }
    signal.throwIfAborted()
    if(!current.isFile() || `${current.dev}:${current.ino}`!==entry.fileIdentity
      || current.size!==entry.fileSize || current.mtimeMs!==entry.fileMtimeMs){
      return {state:'drifted' as const,reason:'native-metrics-source-revision-changed'}
    }
  }
  // EOF proves a bounded native read, not complete runtime facts. The Source
  // owns its recoverability attestation; never infer it from the agent name.
  const sourceCoverageCertified=source.nativeSessionCoverageComplete===true
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
