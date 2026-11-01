import type { IncomingMessage,ServerResponse } from 'node:http'
import type { NativeSessionCatalogStore } from '@agent-lens/core'
import type { NativeOversizedRecordLocateResponseDto } from '@agent-lens/protocol'
import { badRequest,writeJson } from './http-utils'
import { decodeNativeSessionCursor,encodeNativeSessionCursor,
  type NativeSessionWindowReader } from './native-session-http'

/** Search only Source-authorized native physical spans. This is a metadata
 * locator, NOT a complete Review turn, and never exposes filesystem paths.
 */
export async function handleNativeOversizedRecordLocateRequest(
  request:IncomingMessage,response:ServerResponse,url:URL,
  reader?:NativeSessionWindowReader,
  catalog?:Pick<NativeSessionCatalogStore,'getByReviewSessionId'>,
):Promise<boolean>{
  const match=url.pathname.match(/^\/api\/v1\/native-sessions\/([^/]+)\/record-fragments\/locate$/)
  if(!match)return false
  if(request.method!=='GET'){
    response.setHeader('allow','GET')
    writeJson(response,405,{error:'method_not_allowed'})
    return true
  }
  if(!reader?.locateOversizedRecord||!catalog){
    writeJson(response,503,{state:'unavailable',reason:'native-oversized-locator-unavailable'})
    return true
  }
  const names=[...url.searchParams.keys()]
  if(names.some(x=>!['cursor','limit'].includes(x))
    ||names.some(x=>url.searchParams.getAll(x).length!==1))
    throw badRequest('Unsupported oversized record locator parameter')
  const cursor=decodeNativeSessionCursor(url.searchParams.get('cursor'))
  if(cursor&&cursor.mode!=='record-fragments')
    throw badRequest('Locator cursor is not an original record cursor')
  const limit=url.searchParams.has('limit')?Number(url.searchParams.get('limit')):8
  if(!Number.isSafeInteger(limit)||limit<1||limit>8)
    throw badRequest('Invalid oversized locator window')
  let id:string
  try{id=decodeURIComponent(match[1]!)}catch{id=''}
  if(!/^native:[a-f0-9]{32}$/.test(id)){
    writeJson(response,404,{error:'not_found'})
    return true
  }
  const entry=await catalog.getByReviewSessionId(id)
  if(!entry||entry.locationKind!=='native'){
    writeJson(response,404,{error:'not_found'})
    return true
  }
  const controller=new AbortController()
  const close=()=>{if(!response.writableEnded)controller.abort()}
  response.once('close',close)
  try{
    const result=await reader.locateOversizedRecord({
      sourceId:entry.sourceId,installationId:entry.installationId,
      nativeSessionId:entry.nativeSessionId,
      ...(cursor?{cursor}:{}),limit,signal:controller.signal,
    })
    let dto:NativeOversizedRecordLocateResponseDto
    if(result.state==='found')dto={
      state:'found',cursor:encodeNativeSessionCursor({
        ...result.cursor,mode:'record-fragments',
      }),recordSha256:result.recordSha256,hasText:result.hasText,
      ...(result.nativeEventId?{nativeEventId:result.nativeEventId}:{}),
      ...(result.nextCursor?{nextCursor:encodeNativeSessionCursor({
        ...result.nextCursor,mode:'record-fragments',
      })}:{})
    }
    else if(result.state==='more')dto={
      state:'more',nextCursor:encodeNativeSessionCursor({
        ...result.nextCursor,mode:'record-fragments',
      }),
    }
    else dto=result
    writeJson(response,200,dto)
    return true
  }finally{response.off('close',close)}
}
