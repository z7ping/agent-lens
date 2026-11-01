import type { IncomingMessage, ServerResponse } from 'node:http'
import type { NativeSessionCatalogStore } from '@agent-lens/core'
import type { NativeRecordTextFragmentsResponseDto } from '@agent-lens/protocol'
import { badRequest, writeJson } from './http-utils'
import { decodeNativeSessionCursor, type NativeSessionWindowReader } from './native-session-http'

/** Catalog-authorized, sanitized one-record text leaves only. The caller
 * never supplies a filesystem location or a raw SourceRecord.
 */
export async function handleNativeRecordFragmentsRequest(
  request:IncomingMessage,response:ServerResponse,url:URL,
  reader?:NativeSessionWindowReader,
  catalog?:Pick<NativeSessionCatalogStore,'getByReviewSessionId'>,
):Promise<boolean>{
  const match=url.pathname.match(/^\/api\/v1\/native-sessions\/([^/]+)\/record-fragments$/)
  if(!match)return false
  if(request.method!=='GET'){
    response.setHeader('allow','GET')
    writeJson(response,405,{error:'method_not_allowed'})
    return true
  }
  if(!reader?.readTextFragments||!catalog){
    writeJson(response,503,{state:'unavailable',reason:'native-record-fragments-unavailable'})
    return true
  }
  const keys=[...url.searchParams.keys()]
  if(keys.some(x=>!['cursor','expectedSha256','fragmentOffset','limit'].includes(x))
    ||keys.some(x=>url.searchParams.getAll(x).length!==1))
    throw badRequest('Unsupported record-fragment query parameter')
  const cursor=decodeNativeSessionCursor(url.searchParams.get('cursor'))
  if(!cursor||!['review-turns','record-fragments'].includes(cursor.mode??'')
    ||!cursor.recordFingerprint)
    throw badRequest('Verified Review turn cursor required')
  const expectedSha256=url.searchParams.get('expectedSha256')??undefined
  const fragmentOffset=url.searchParams.has('fragmentOffset')
    ?Number(url.searchParams.get('fragmentOffset')):0
  const limit=url.searchParams.has('limit')?Number(url.searchParams.get('limit')):4
  if(!Number.isSafeInteger(fragmentOffset)||fragmentOffset<0||fragmentOffset>10_000_000
    ||!Number.isSafeInteger(limit)||limit<1||limit>8
    ||(expectedSha256!==undefined&&!/^[0-9a-f]{64}$/.test(expectedSha256))
    ||(fragmentOffset>0&&!expectedSha256))
    throw badRequest('Invalid record fragment boundary')
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
  const abort=new AbortController()
  const close=()=>{if(!response.writableEnded)abort.abort()}
  response.once('close',close)
  try{
    const result=await reader.readTextFragments({
      sourceId:entry.sourceId,installationId:entry.installationId,
      nativeSessionId:entry.nativeSessionId,cursor,fragmentOffset,limit,
      signal:abort.signal,
      ...(expectedSha256?{expectedSha256}:{}),
    })
    if(result.state!=='available'){
      writeJson(response,200,result)
      return true
    }
    // Raw text is never emitted from the Source adapter directly: the Reader
    // has already applied CapturePolicy to every fragment.
    const dto:NativeRecordTextFragmentsResponseDto={
      state:'available',coverage:'fragment-only',sessionId:id,
      recordSha256:result.record.recordSha256,
      ...(result.record.nativeEventId?{nativeEventId:result.record.nativeEventId}:{}),
      ...(result.record.nativeType?{nativeType:result.record.nativeType}:{}),
      ...(result.record.role?{role:result.record.role}:{}),
      fragments:result.record.fragments,
      totalTextFragments:result.record.totalTextFragments,
      ...(result.record.images?{images:result.record.images}:{}),
      ...(result.record.nextFragmentOffset===undefined?{}:{
        nextFragmentOffset:result.record.nextFragmentOffset,
      }),
    }
    if(Buffer.byteLength(JSON.stringify(dto),'utf8')>256*1024){
      writeJson(response,200,{state:'unsupported',reason:'native-fragment-response-budget'})
      return true
    }
    writeJson(response,200,dto)
    return true
  }finally{response.off('close',close)}
}
