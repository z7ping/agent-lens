import type { ReviewMessageAttachmentDto } from '@agent-lens/protocol'
import type { AgentLensApi } from './api'

export type NativeMediaRef = NonNullable<ReviewMessageAttachmentDto['nativeMedia']>
const MAX_BASE64=8*1024*1024
const CHUNK=128*1024

/** One source of truth for both oversized-record Disclosure and shared
 * TaskMessage image previews. Each chunk is independently SHA/identity bound.
 * No untrusted URLs, disk paths or streaming full-image JSON responses.
 */
export async function loadNativeImagePreview(
  api:Pick<AgentLensApi,'nativeRecordMediaChunk'>,
  ref:NativeMediaRef,
  signal?:AbortSignal,
):Promise<string>{
  if(!/^native:[0-9a-f]{32}$/.test(ref.sessionId)
    ||!/^[0-9a-f]{64}$/.test(ref.recordSha256)
    ||!Number.isSafeInteger(ref.contentIndex)||ref.contentIndex<0
    ||!/^image\/(png|jpeg|gif|webp)$/.test(ref.mimeType)
    ||!ref.cursor)throw new Error('native-media-reference-invalid')
  let offset=0
  let total=-1
  const chunks:string[]=[]
  let downloaded=0
  for(let n=0;n<64;n++){
    signal?.throwIfAborted()
    const page=await api.nativeRecordMediaChunk(ref.sessionId,{
      cursor:ref.cursor,expectedSha256:ref.recordSha256,
      imageIndex:ref.contentIndex,mediaOffset:offset,mediaLimit:CHUNK,
      ...(signal?{signal}:{}),
    })
    signal?.throwIfAborted()
    if(page.state!=='available')throw new Error(page.reason)
    if(page.coverage!=='media-chunk-only'
      ||page.sessionId!==ref.sessionId
      ||page.recordSha256!==ref.recordSha256
      ||page.contentIndex!==ref.contentIndex
      ||page.mimeType!==ref.mimeType
      ||!page.base64||page.base64.length>CHUNK
      ||page.base64.length%4!==0
      ||!/^[A-Za-z0-9+/=]+$/.test(page.base64)
      ||!Number.isSafeInteger(page.totalBase64Length)
      ||page.totalBase64Length<4||page.totalBase64Length>MAX_BASE64
      ||page.totalBase64Length%4!==0
      ||(total>=0&&page.totalBase64Length!==total)
      ||offset+page.base64.length>page.totalBase64Length
      ||(page.nextOffset!==undefined&&page.nextOffset!==offset+page.base64.length))
      throw new Error('native-media-evidence-mismatch')
    total=page.totalBase64Length
    chunks.push(page.base64)
    downloaded+=page.base64.length
    if(downloaded>MAX_BASE64)throw new Error('native-media-preview-budget')
    if(page.nextOffset===undefined){
      if(downloaded!==total)throw new Error('native-media-incomplete')
      return `data:${ref.mimeType};base64,${chunks.join('')}`
    }
    if(page.nextOffset<=offset)throw new Error('native-media-cursor-stalled')
    offset=page.nextOffset
  }
  throw new Error('native-media-preview-budget')
}
