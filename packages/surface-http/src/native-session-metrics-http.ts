import type { IncomingMessage, ServerResponse } from 'node:http'
import { NATIVE_SESSION_METRIC_PROJECTION_VERSION } from '@agent-lens/core'
import type {
  CapturePolicyService, NativeSessionCatalogStore, NativeSessionMetricsStore,
  SourceService, SourceNativeSessionCursor,
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
    const accumulator=new NativeSessionMetricAccumulator()
    let cursor:SourceNativeSessionCursor|undefined
    let exhausted=false
    let pendingTail=false
    let scannedRecords=0
    for(let pageIndex=0;pageIndex<MAX_PAGES;pageIndex++){
      const result=await reader!.read({
        ...identity,limit:PAGE_LIMIT,signal:abort.signal,
        ...(cursor?{cursor}:{}),
      })
      if(abort.signal.aborted||response.destroyed)return true
      if(result.state!=='available'){
        writeJson(response,200,result)
        return true
      }
      if(result.observations.length!==result.observationRecordIds.length){
        writeJson(response,200,{state:'unsupported',reason:'native-metrics-source-boundaries-invalid'})
        return true
      }
      // An advancing Source-owned cursor is mandatory. Avoid infinite loops
      // on a malformed reader / concurrently rewritten native database.
      if(cursor && result.nextCursor.fileIdentity!==cursor.fileIdentity){
        writeJson(response,200,{state:'drifted',reason:'native-metrics-source-identity-changed'})
        return true
      }
      if(result.hasMore && cursor
        && result.nextCursor.offset===cursor.offset
        && result.nextCursor.sequence===cursor.sequence){
        writeJson(response,200,{state:'unsupported',reason:'native-metrics-source-cursor-not-advancing'})
        return true
      }
      for(const observation of result.observations)accumulator.add(observation)
      scannedRecords+=result.observations.length
      cursor=result.nextCursor
      pendingTail=result.pendingTail
      if(!result.hasMore){exhausted=true;break}
    }
    if(abort.signal.aborted||response.destroyed)return true
    // Native EOF proves only that this bounded reader reached its current
    // end. It does NOT prove full Tool/Error/Usage semantics for an adapter.
    // In particular OpenCode's mutable SQLite needs stronger provenance and
    // missing permission/Subagent facts; Codex/Claude/Hermes still need Hook
    // merge guarantees. Pi is the only initially certified numerical Source.
    const sourceCoverageCertified=entry.sourceId==='pi'
    const snapshot=accumulator.snapshot({
      ...identity,fileIdentity:entry.fileIdentity,fileSize:entry.fileSize,
      fileMtimeMs:entry.fileMtimeMs,parserVersion:source.manifest.parserVersion,
      projectionVersion:PROJECTION_VERSION,computedAt:new Date().toISOString(),
      complete:exhausted&&!pendingTail&&sourceCoverageCertified,
    })
    if(!await metrics.replace(snapshot)){
      writeJson(response,200,{state:'drifted',reason:'native-metrics-catalog-revision-changed'})
      return true
    }
    writeJson(response,200,{
      state:'available',
      coverage:snapshot.coverage,
      metricVersion:snapshot.projectionVersion,
      scannedObservations:scannedRecords,
      reason:!exhausted?'native-metrics-page-budget'
        :pendingTail?'native-metrics-pending-tail'
          :!sourceCoverageCertified?'native-source-coverage-unverified':null,
      snapshot,
    })
    return true
  }finally{
    response.off('close',onClose)
  }
}
