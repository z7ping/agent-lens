import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  CapturePolicyService, LiveService, SourceService,
  NativeSessionListReader, NativeSessionCatalogStore,
} from '@agent-lens/core'
import { nativeLiveHistoryReference } from './live-history-reference'
import { readNativeOnlyFileChanges } from './native-only-task-files-http'
import type { NativeSessionWindowReader } from './native-session-http'
import { badRequest, httpError, writeJson } from './http-utils'

/** Resolves the unique original Source before projecting an active Live task's
 * file evidence. Same Reader as Review, not the retired SQL runtime capture.
 */
export async function handleNativeOnlyRuntimeFilesRequest(
  request:IncomingMessage,response:ServerResponse,url:URL,
  lives:LiveService|undefined,sessions:NativeSessionListReader,
  catalog:Pick<NativeSessionCatalogStore,'getByReviewSessionId'>,
  reader:NativeSessionWindowReader,sources:SourceService,
  policy:Pick<CapturePolicyService,'isSourceEnabled'>,
):Promise<boolean>{
  const match=url.pathname.match(/^\/api\/v1\/task-file-changes\/runtime\/([^/]+)$/)
  if(!match)return false
  if(request.method!=='GET'){
    response.setHeader('allow','GET')
    writeJson(response,405,{error:'method_not_allowed'})
    return true
  }
  let runtimeId:string
  try{runtimeId=decodeURIComponent(match[1]!)}catch{throw badRequest('Invalid runtime identity')}
  if(!runtimeId||runtimeId.length>512)throw badRequest('Invalid runtime identity')
  if(!lives)throw httpError(503,'Live registry unavailable')
  const adapters=lives.list()
  const resolved=await Promise.allSettled(adapters.map(async adapter=>({
    adapter,runtimes:await adapter.list(),
  })))
  if(resolved.some(row=>row.status==='rejected')){
    throw httpError(503,'Live runtime ownership is unavailable')
  }
  const owners=resolved.flatMap(row=>row.status==='fulfilled'
    ?row.value.runtimes.filter(state=>state.runtimeSessionId===runtimeId)
      .map(state=>({adapter:row.value.adapter,state})):[])
  if(owners.length!==1){
    throw httpError(owners.length?409:404,
      owners.length?'Ambiguous native runtime':'Live runtime not found')
  }
  const {adapter,state}=owners[0]!
  const reference=await nativeLiveHistoryReference(sessions,sources,policy,adapter,state)
  const id=reference.historySessionId
  if(!id)throw httpError(409,'Original Live session is not uniquely indexed')
  const entry=await catalog.getByReviewSessionId(id)
  if(!entry||entry.locationKind!=='native'
    ||!policy.isSourceEnabled(entry.sourceId)
    ||!sources.list().some(source=>source.manifest.sourceId===entry.sourceId
      &&source.manifest.productId===adapter.manifest.productId)){
    throw httpError(409,'Original Live Source identity cannot be verified')
  }
  writeJson(response,200,await readNativeOnlyFileChanges(id,entry,reader))
  return true
}
