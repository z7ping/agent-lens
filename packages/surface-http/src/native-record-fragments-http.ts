import type { IncomingMessage, ServerResponse } from 'node:http'
import type { NativeSessionCatalogStore } from '@agent-lens/core'
import type { NativeRecordTextFragmentsResponseDto, NativeRecordMediaChunkResponseDto, NativeRecordToolLinkResponseDto } from '@agent-lens/protocol'
import { badRequest, writeJson } from './http-utils'
import { decodeNativeSessionCursor, encodeNativeSessionCursor, type NativeSessionWindowReader } from './native-session-http'

/** Catalog-authorized bounded text or inline media leaves. No filesystem
 * location or original SourceRecord is supplied by the browser.
 */
export async function handleNativeRecordFragmentsRequest(
  request:IncomingMessage,response:ServerResponse,url:URL,
  reader?:NativeSessionWindowReader,
  catalog?:Pick<NativeSessionCatalogStore,'getByReviewSessionId'>,
):Promise<boolean>{
  const match=url.pathname.match(/^\/api\/v1\/native-sessions\/([^/]+)\/record-fragments(\/media|\/link)?$/)
  const mediaMode=match?.[2]==='/media'
  const linkMode=match?.[2]==='/link'
  if(!match)return false
  if(request.method!=='GET'){
    response.setHeader('allow','GET')
    writeJson(response,405,{error:'method_not_allowed'})
    return true
  }
  if(!(linkMode?reader?.findNativeToolResult:reader?.readTextFragments)||!catalog){
    writeJson(response,503,{state:'unavailable',reason:'native-record-fragments-unavailable'})
    return true
  }
  const keys=[...url.searchParams.keys()]
  const allowedKeys=linkMode
    ?['cursor','expectedSha256','fragmentOrdinal','contentIndex','callKey','scanCursor','limit']
    :mediaMode?['cursor','expectedSha256','imageIndex','mediaOffset','mediaLimit']
      :['cursor','expectedSha256','fragmentOffset','limit']
  if(keys.some(x=>!allowedKeys.includes(x))
    ||keys.some(x=>url.searchParams.getAll(x).length!==1))
    throw badRequest('Unsupported record-fragment query parameter')
  const cursor=decodeNativeSessionCursor(url.searchParams.get('cursor'))
  const structuralBodyCursor=Boolean(!mediaMode&&!linkMode
    &&cursor&&!cursor.mode
    &&/^[0-9a-f]{64}$/.test(url.searchParams.get('expectedSha256')??''))
  if(!cursor||!(['review-turns','record-fragments'].includes(cursor.mode??'')
    ||structuralBodyCursor)
    ||!cursor.recordFingerprint||(linkMode&&cursor.mode!=='record-fragments'))
    throw badRequest('Verified Review turn cursor required')
  const expectedSha256=url.searchParams.get('expectedSha256')??undefined
  const callKey=url.searchParams.get('callKey')??''
  const fragmentOrdinal=Number(url.searchParams.get('fragmentOrdinal'))
  const contentIndex=Number(url.searchParams.get('contentIndex'))
  const hasFragmentOrdinal=url.searchParams.has('fragmentOrdinal')
  const hasContentIndex=url.searchParams.has('contentIndex')
  const scanCursor=linkMode
    ?decodeNativeSessionCursor(url.searchParams.get('scanCursor')):undefined
  const fragmentOffset=url.searchParams.has('fragmentOffset')
    ?Number(url.searchParams.get('fragmentOffset')):0
  const limit=url.searchParams.has('limit')?Number(url.searchParams.get('limit')):4
  const imageIndex=url.searchParams.has('imageIndex')
    ?Number(url.searchParams.get('imageIndex')):NaN
  const mediaOffset=url.searchParams.has('mediaOffset')
    ?Number(url.searchParams.get('mediaOffset')):0
  const mediaLimit=url.searchParams.has('mediaLimit')
    ?Number(url.searchParams.get('mediaLimit')):128*1024
  if((linkMode&&(!expectedSha256||!/^[0-9a-f]{64}$/.test(callKey)
      ||hasFragmentOrdinal===hasContentIndex
      ||(hasFragmentOrdinal&&(!Number.isSafeInteger(fragmentOrdinal)
        ||fragmentOrdinal<0||fragmentOrdinal>10_000_000))
      ||(hasContentIndex&&(!Number.isSafeInteger(contentIndex)
        ||contentIndex<0||contentIndex>10_000_000))
      ||!Number.isSafeInteger(limit)
      ||limit<1||limit>4
      ||(scanCursor&&(scanCursor.mode!=='record-fragments'
        ||scanCursor.fileIdentity!==cursor.fileIdentity
        ||scanCursor.offset<=cursor.offset))))
    ||(!mediaMode&&!linkMode&&(!Number.isSafeInteger(fragmentOffset)||fragmentOffset<0
      ||fragmentOffset>10_000_000||!Number.isSafeInteger(limit)||limit<1||limit>8))
    ||(expectedSha256!==undefined&&!/^[0-9a-f]{64}$/.test(expectedSha256))
    ||(!mediaMode&&!linkMode&&fragmentOffset>0&&!expectedSha256)
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
    if(linkMode){
      const found=await reader!.findNativeToolResult!({
        sourceId:entry.sourceId,installationId:entry.installationId,
        nativeSessionId:entry.nativeSessionId,cursor,
        expectedSha256:expectedSha256!,
        ...(hasFragmentOrdinal?{fragmentOrdinal}:{}),
        ...(hasContentIndex?{contentIndex}:{}),
        callKey,
        ...(scanCursor?{scanCursor}:{}),limit,signal:abort.signal,
      })
      if(found.state!=='available'){
        writeJson(response,200,found)
        return true
      }
      if(!Number.isSafeInteger(found.scannedRecords)
        ||found.scannedRecords<0||found.scannedRecords>limit
        ||(found.match&&(!/^[0-9a-f]{64}$/.test(found.match.recordSha256)
          ||found.match.cursor.fileIdentity!==cursor.fileIdentity
          ||found.match.cursor.offset<=cursor.offset
          ||!/^[0-9a-f]{64}$/.test(found.match.cursor.recordFingerprint??'')))
        ||(found.nextCursor&&(found.match
          ||found.nextCursor.fileIdentity!==cursor.fileIdentity
          ||found.nextCursor.offset<=cursor.offset))){
        writeJson(response,200,{state:'unsupported',reason:'native-tool-link-evidence-invalid'})
        return true
      }
      const dto:NativeRecordToolLinkResponseDto={
        state:'available',coverage:'tool-link-only',sessionId:id,
        scannedRecords:found.scannedRecords,
        ...(found.match?{match:{
          cursor:encodeNativeSessionCursor({...found.match.cursor,
            mode:'record-fragments'}),
          recordSha256:found.match.recordSha256,
        }}:{}),
        ...(found.nextCursor?{nextCursor:encodeNativeSessionCursor({
          ...found.nextCursor,mode:'record-fragments',
        })}:{}),
      }
      writeJson(response,200,dto)
      return true
    }
    const result=await reader!.readTextFragments!({
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
        ||!/^(image\/(png|jpeg|gif|webp))$/.test(media.mimeType)
        ||!/^[A-Za-z0-9+/=]+$/.test(media.base64)
        ||media.base64.length>mediaLimit
        ||media.base64.length%4!==0
        ||!Number.isSafeInteger(media.totalBase64Length)
        ||media.totalBase64Length<4||media.totalBase64Length%4!==0
        ||mediaOffset+media.base64.length>media.totalBase64Length
        ||(media.nextOffset!==undefined
          &&media.nextOffset!==mediaOffset+media.base64.length)
        ||(media.nextOffset===undefined
          &&mediaOffset+media.base64.length!==media.totalBase64Length)){
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
      // Explicit DTO whitelist: Source/Reader may carry private policy
      // context, which must never be spread into a browser response.
      fragments:result.record.fragments.map(fragment=>({
        ordinal:fragment.ordinal,text:fragment.text,kind:fragment.kind,
        ...(fragment.contentIndex===undefined?{}:{contentIndex:fragment.contentIndex}),
        ...(fragment.callKey?{callKey:fragment.callKey}:{}),
        ...(fragment.valueType?{valueType:fragment.valueType}:{}),
        ...(fragment.redactionApplied?{redactionApplied:true}:{}),
        ...(fragment.suppressed?{suppressed:true}:{}),
        ...(fragment.splitScalar?{splitScalar:true}:{}),
      })),
      totalTextFragments:result.record.totalTextFragments,
      // Explicit block whitelist. Never serialize Source-private argument
      // ancestry or unfiltered native tool names/IDs.
      ...(result.record.contentBlocks?{contentBlocks:result.record.contentBlocks.map(block=>({
        contentIndex:block.contentIndex,kind:block.kind,
        fragmentCount:block.fragmentCount,
        ...(block.name?{name:block.name}:{}),
        ...(block.callKey?{callKey:block.callKey}:{}),
        ...(block.redactionApplied?{redactionApplied:true}:{}),
        ...(block.suppressed?{suppressed:true}:{}),
      }))}:{}),
      ...(result.record.contentBlocksTruncated?{contentBlocksTruncated:true}:{}),
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
