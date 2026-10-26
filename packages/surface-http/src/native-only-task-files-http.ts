import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CapturePolicyService, NativeSessionCatalogStore, NativeSessionCatalogEntry, TaskFileChangeRecord } from '@agent-lens/core'
import { projectNativeReviewWindow } from '@agent-lens/projection-review'
import { taskFileChangesResponse } from './task-file-changes-response'
import { readContiguousReviewPages, type NativeSessionWindowReader } from './native-session-http'
import { badRequest, httpError, writeJson } from './http-utils'

const PATH=/^\/api\/v1\/review\/([^/]+)\/(file-changes|file-diff)$/
const REVIEW_ID=/^native:[0-9a-f]{32}$/

/** Existing Task Surface endpoints, original Source-only evidence.
 * No SQL TaskFileChange projection, no inferred Git tree or legacy fallback.
 */
export async function handleNativeOnlyTaskFilesRequest(
  request:IncomingMessage,response:ServerResponse,url:URL,
  catalog:Pick<NativeSessionCatalogStore,'getByReviewSessionId'>,
  reader:NativeSessionWindowReader,
  policy:Pick<CapturePolicyService,'isSourceEnabled'>,
):Promise<boolean>{
  const match=url.pathname.match(PATH)
  if(!match)return false
  if(request.method!=='GET'){
    response.setHeader('allow','GET')
    writeJson(response,405,{error:'method_not_allowed'})
    return true
  }
  let id:string
  try{id=decodeURIComponent(match[1]!)}catch{throw badRequest('Invalid native review id')}
  if(!REVIEW_ID.test(id)){
    writeJson(response,404,{error:'not_found'})
    return true
  }
  const entry=await catalog.getByReviewSessionId(id)
  if(!entry||entry.locationKind!=='native'||!policy.isSourceEnabled(entry.sourceId)){
    writeJson(response,404,{error:'not_found'})
    return true
  }
  if(match[2]==='file-diff'){
    const path=url.searchParams.get('path')?.trim()
    if(!path||path.length>4096)throw badRequest('Invalid native file diff path')
    // A tool-observed file change is not proof of a Git baseline.
    writeJson(response,200,{path,available:false,reason:'not-exact'})
    return true
  }
  // Turn-level selection cannot be guessed from a whole-session byte window.
  if(url.searchParams.size>0){
    writeJson(response,501,{error:'native_interaction_file_changes_unavailable'})
    return true
  }
  writeJson(response,200,await readNativeOnlyFileChanges(id,entry,reader))
  return true
}

/** The one bounded native Source evidence reader for Review AND active Live. */
export async function readNativeOnlyFileChanges(
  id:string,entry:NativeSessionCatalogEntry,
  reader:NativeSessionWindowReader,
){
  const query={
    sourceId:entry.sourceId,installationId:entry.installationId,
    nativeSessionId:entry.nativeSessionId,limit:16,
    signal:AbortSignal.timeout(30_000),
  }
  const first=await reader.read(query)
  const result=first.state==='available'
    ?await readContiguousReviewPages(reader,query,first):first
  if(result.state!=='available'){
    throw httpError(409,'Native file changes unavailable: '+result.reason)
  }
  const window=projectNativeReviewWindow({
    sourceId:entry.sourceId,installationId:entry.installationId,
    nativeSessionId:entry.nativeSessionId,
    observations:result.observations,
    observationRecordIds:result.observationRecordIds,
    evidenceCandidates:result.evidenceCandidates,
    hasMore:result.hasMore,pendingTail:result.pendingTail,
    hasPrevious:false,nextCursor:'',
  })
  const items:TaskFileChangeRecord[]=(window.observedFileChanges??[]).map(change=>({
    logicalSessionId:id,path:change.path,changeType:change.changeType,
    ...(change.oldPath?{oldPath:change.oldPath}:{}),
    firstChangedAt:change.firstChangedAt,lastChangedAt:change.lastChangedAt,
    evidence:change.evidence,confidence:change.confidence,
  }))
  return taskFileChangesResponse(id,items,null,{
    truncated:result.hasMore||result.pendingTail||window.fileChangesTruncated===true,
  })
}
