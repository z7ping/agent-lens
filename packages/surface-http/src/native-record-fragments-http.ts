import type { IncomingMessage, ServerResponse } from 'node:http'
import type { NativeSessionCatalogStore } from '@agent-lens/core'
import type { NativeRecordTextFragmentsResponseDto, NativeRecordMediaChunkResponseDto } from '@agent-lens/protocol'
import { badRequest, writeJson } from './http-utils'
import { decodeNativeSessionCursor, type NativeSessionWindowReader } from './native-session-http'

/** Catalog-authorized bounded text or inline media leaves. No filesystem
 * location or original SourceRecord is supplied by the browser.
 */
export async function handleNativeRecordFragmentsRequest(
  request:IncomingMessage,response:ServerResponse,url:URL,
  reader?:NativeSessionWindowReader,
  catalog?:Pick<NativeSessionCatalogStore,'getByReviewSessionId'>,
):Promise<boolean>{
  const match=url.pathname.match(/^\/api\/v1\/native-sessions\/([^/]+)\/record-fragments(\/media)?$/)
  const mediaMode=Boolean(match?.[2])
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
  const allowedKeys=mediaMode
    ?['cursor','expectedSha256','imageIndex','mediaOffset','mediaLimit']
    :['cursor','expectedSha256','fragmentOffset','limit']
  if(keys.some(x=>!allowedKeys.includes(x))
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
  const imageIndex=url.searchParams.has('imageIndex')
    ?Number(url.searchParams.get('imageIndex')):NaN
  const mediaOffset=url.searchParams.has('mediaOffset')
    ?Number(url.searchParams.get('mediaOffset')):0
  const mediaLimit=url.searchParams.has('mediaLimit')
    ?Number(url.searchParams.get('mediaLimit')):128*1024
  if((!mediaMode&&(!Number.isSafeInteger(fragmentOffset)||fragmentOffset<0
      ||fragmentOffset>10_000_000||!Number.isSafeInteger(limit)||limit<1||limit>8))
    ||(expectedSha256!==undefined&&!/^[0-9a-f]{64}$/.test(expectedSha256))
    ||(!mediaMode&&fragmentOffset>0&&!expectedSha256)
    ||(mediaMode&&(!expectedSha256
      ||!Number.isSafeInteger(imageIndex)||imageIndex<0||imageIndex>10_000_000
      ||!Number.isSafeInteger(mediaOffset)||mediaOffset<0||mediaOffset%4!==0
      ||!Number.isSafeInteger(mediaLimit)||mediaLimit<4
      ||mediaLimit>128*1024||mediaLimit%4!==0)))
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
      nativeSessionId:entry.nativeSessionId,cursor,
      ...(mediaMode?{media:{contentIndex:imageIndex,offset:mediaOffset,limit:mediaLimit}}
        :{fragmentOffset,limit}),
      signal:abort.signal,
      ...(expectedSha256?{expectedSha256}:{}),
    })
    if(result.state!=='available'){
      writeJson(response,200,result)
      return true
    }
    if(mediaMode){
      const media=result.record.media
      if(!media||media.contentIndex!==imageIndex
        ||result.record.recordSha256!==expectedSha256
        ||media.base64.length>mediaLimit){
        writeJson(response,200,{state:'unsupported',reason:'native-inline-image-window-invalid'})
        return true
      }
      const dto:NativeRecordMediaChunkResponseDto={
        state:'available',coverage:'media-chunk-only',sessionId:id,
        recordSha256:result.record.recordSha256,
        contentIndex:media.contentIndex,mimeType:media.mimeType,
        base64:media.base64,totalBase64Length:media.totalBase64Length,
        ...(media.nextOffset===undefined?{}:{nextOffset:media.nextOffset}),
      }
      if(Buffer.byteLength(JSON.stringify(dto),'utf8')>256*1024){
        writeJson(response,200,{state:'unsupported',reason:'native-media-response-budget'})
        return true
      }
      writeJson(response,200,dto)
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
      ...(result.record.imagesTruncated?{imagesTruncated:true}:{}),
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
