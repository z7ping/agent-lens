import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { parser, type Token } from 'stream-json/parser.js'
import { sourceFileIdentity } from './source-fs'
import {
  authorizeNativeSessionPath, inspectNativeSessionRecordSpan,
  type NativeSessionCursor,
} from './native-session-window'

const CHUNK_BYTES=64*1024
const FRAGMENT_BYTES=8*1024
const MAX_FRAGMENT_COUNT=16
const MAX_FRAGMENT_OFFSET=10_000_000
const MAX_KEY_BYTES=256
const MAX_META_BYTES=512
const MAX_DEPTH=128

export interface NativeJsonlTextFragment {
  /** Ordinal of a bounded, decoded UTF-8 text fragment inside one record. */
  ordinal:number
  text:string
  /** Source-verified semantic lane; fragments are never complete events. */
  kind:'message'|'thinking'|'tool-call'|'tool-result'
  /** Native content[] index, not a synthetic turn. */
  contentIndex?:number
  /** SHA-256 of bounded native tool ID, without disclosing the raw ID. */
  callKey?:string
  /** This text leaf spans multiple fragments; policy must not redact them
   * separately without taking token-boundary context into account. */
  splitScalar?:boolean
}

export type NativeJsonlFragmentReadResult =
  | {state:'available';record:{
      offset:number;fileIdentity:string;recordSha256:string
      /** SHA-256 excluding an optional CRLF record delimiter. */
      sourceLineSha256:string
      nativeEventId?:string;nativeType?:string;role?:string
      fragments:NativeJsonlTextFragment[]
      totalTextFragments:number;nextFragmentOffset?:number
    }}
  | {state:'pending'|'unavailable'|'drifted'|'unsupported';reason:string}

type PathKey=string|number
type Frame={kind:'object'|'array';path:PathKey[];key?:string;next:number}
type StringKind='id'|'type'|'role'|'text'|'thinking'|'argument'
  |'blockType'|'blockId'|'resultCallId'|'ignored'
type FragmentKind=NativeJsonlTextFragment['kind']

function contentIndex(path:readonly PathKey[]):number|undefined{
  return path[0]==='message'&&path[1]==='content'
    &&typeof path[2]==='number'?path[2]:undefined
}

function classify(path:readonly PathKey[]):StringKind{
  if(path.length===1&&path[0]==='id')return 'id'
  if(path.length===1&&path[0]==='type')return 'type'
  if(path.length===2&&path[0]==='message'&&path[1]==='role')return 'role'
  if(path.length===2&&path[0]==='message'&&path[1]==='toolCallId')return 'resultCallId'
  // Scalar and typed message content; media/base64 stays outside this lane.
  if(path.length===2&&path[0]==='message'&&path[1]==='content')return 'text'
  const index=contentIndex(path)
  if(index===undefined)return 'ignored'
  if(path.length===3)return 'text'
  if(path.length===4&&path[3]==='type')return 'blockType'
  if(path.length===4&&path[3]==='id')return 'blockId'
  if(path.length===4&&path[3]==='thinking')return 'thinking'
  if(path[3]==='text'&&(path.length===4
    ||(path.length===5&&typeof path[4]==='number')))return 'text'
  // Only known toolCall blocks may yield nested argument strings.
  if(path.length>=4&&(path[3]==='arguments'||path[3]==='args')
    &&!path.some(key=>key==='data'||key==='base64'||key==='image'))return 'argument'
  return 'ignored'
}

/** Verify a complete native JSONL record while never packing individual JSON
 * strings. stream-json emits decoded stringChunk tokens without materializing
 * giant strings, unlike partial-token parsers that retain full scalar buffers.
 * Each bounded text chunk is a fragment, not a new SourceRecord or complete
 * Review turn. The caller must apply CapturePolicy BEFORE exposing fragments.
 */
export async function readNativeJsonlTextFragments(input:{
  path:string;allowedRoots:readonly string[];cursor?:NativeSessionCursor
  expectedSha256?:string;fragmentOffset?:number;limit?:number;signal?:AbortSignal
}):Promise<NativeJsonlFragmentReadResult>{
  const fragmentOffset=input.fragmentOffset??0
  const limit=input.limit??8
  if(!Number.isSafeInteger(fragmentOffset)||fragmentOffset<0
    ||fragmentOffset>MAX_FRAGMENT_OFFSET
    ||!Number.isSafeInteger(limit)||limit<1||limit>MAX_FRAGMENT_COUNT)
    return {state:'unsupported',reason:'invalid-fragment-window'}
  const scan=await inspectNativeSessionRecordSpan(input)
  if(scan.state!=='available')return scan
  const {span}=scan
  const auth=await authorizeNativeSessionPath(input.path,input.allowedRoots)
  if(auth.state!=='authorized')return auth
  const file=await open(auth.sourcePath,'r')
  try{
    const original=await file.stat()
    if(!original.isFile()||sourceFileIdentity(original)!==span.fileIdentity
      ||original.size<span.nextOffset)
      return {state:'drifted',reason:'native-record-changed-during-scan'}

    const sha=createHash('sha256')
    const lineSha=createHash('sha256')
    const fragments:NativeJsonlTextFragment[]=[]
    let totalTextFragments=0
    let selectedBytes=0
    let nativeEventId:string|undefined
    let nativeType:string|undefined
    let role:string|undefined
    let resultCallId:string|undefined
    let currentBlock:{index:number;type?:string;id?:string}|undefined
    let selectedIndex:number|undefined
    let textKind:FragmentKind='message'
    let failed:string|undefined
    let inKey=false
    let keyBuffer=''
    let keyBytes=0
    let stringKind:StringKind='ignored'
    let meta=''
    let textBuffer=''
    let textBytes=0
    let textPieces=0
    let currentTextLeaf=0
    let nextTextLeaf=0
    const selectedLeafIds:number[]=[]
    let pendingHighSurrogate=''
    let firstToken=true
    const stack:Frame[]=[]

    const nextPath=():PathKey[]=>{
      const frame=stack.at(-1)
      if(!frame)return []
      if(frame.kind==='array')return [...frame.path,frame.next++]
      if(frame.key===undefined)throw new Error('invalid-source-json-structure')
      const result=[...frame.path,frame.key]
      frame.key=undefined
      return result
    }
    const flushText=()=>{
      // Empty text values are still first-class leaves.
      const ordinal=totalTextFragments++
      if(ordinal>=fragmentOffset && fragments.length<limit){
        if(selectedBytes+textBytes>128*1024){
          failed='native-fragment-output-budget'
          throw new Error(failed)
        }
        fragments.push({ordinal,text:textBuffer,kind:textKind,
          ...(selectedIndex===undefined?{}:{contentIndex:selectedIndex})})
        selectedLeafIds.push(currentTextLeaf)
        selectedBytes+=textBytes
      }
      textPieces++
      textBuffer=''
      textBytes=0
    }
    const writeText=(text:string)=>{
      const combined=pendingHighSurrogate+text
      pendingHighSurrogate=''
      // Preserve surrogate pairs even when streamed JSON stringChunk tokens
      // end after a standalone high surrogate.
      const last=combined.charCodeAt(combined.length-1)
      const safe=last>=0xd800&&last<=0xdbff
        ?(pendingHighSurrogate=combined.slice(-1),combined.slice(0,-1))
        :combined
      // Token chunks can end between escape sequences or UTF-8 code points;
      // stream-json has already decoded those boundaries. Split only between
      // complete JS code points, never within a surrogate pair.
      for(const codePoint of safe){
        const n=Buffer.byteLength(codePoint,'utf8')
        if(textBytes+n>FRAGMENT_BYTES)flushText()
        textBuffer+=codePoint
        textBytes+=n
      }
    }
    const onToken=(token:Token)=>{
      const {name}=token
      if(firstToken){
        firstToken=false
        if(name!=='startObject'){
          failed='native-record-not-object'
          throw new Error(failed)
        }
      }
      switch(name){
        case 'startObject':
        case 'startArray':{
          const path=nextPath()
          if(name==='startObject'&&path.length===3
            &&contentIndex(path)!==undefined)
            currentBlock={index:path[2] as number}
          if(stack.length>=MAX_DEPTH){
            failed='native-record-depth-budget'
            throw new Error(failed)
          }
          stack.push({kind:name==='startObject'?'object':'array',path,next:0})
          return
        }
        case 'endObject':
        case 'endArray':{
          const frame=stack.at(-1)
          if(!frame){failed='native-record-invalid-json';throw new Error(failed)}
          if(name==='endObject'&&frame.path.length===3&&currentBlock
            &&contentIndex(frame.path)===currentBlock.index){
            for(const fragment of fragments){
              if(fragment.contentIndex!==currentBlock.index)continue
              if(fragment.kind==='message'&&currentBlock.type==='thinking')
                fragment.kind='thinking'
              if(fragment.kind==='message'&&currentBlock.type
                &&currentBlock.type!=='text'&&currentBlock.type!=='thinking'){
                failed='native-record-unverified-content-block'
                throw new Error(failed)
              }
              if(fragment.kind==='tool-call'&&currentBlock.type==='toolCall'
                &&currentBlock.id)
                fragment.callKey=createHash('sha256').update(currentBlock.id).digest('hex')
            }
            currentBlock=undefined
          }
          stack.pop()
          return
        }
        case 'startKey':
          inKey=true;keyBuffer='';keyBytes=0
          return
        case 'endKey':{
          inKey=false
          const current=stack.at(-1)
          if(!current||current.kind!=='object'){
            failed='native-record-invalid-json';throw new Error(failed)
          }
          current.key=keyBuffer
          return
        }
        case 'startString':{
          const path=nextPath()
          selectedIndex=contentIndex(path)
          stringKind=classify(path)
          // A late/missing type cannot authorize arbitrary tool arguments.
          if(stringKind==='argument'&&currentBlock?.type!=='toolCall')
            stringKind='ignored'
          if(stringKind==='thinking'&&currentBlock?.type!=='thinking')
            stringKind='ignored'
          if(stringKind==='text'&&currentBlock?.type
            &&currentBlock.type!=='text'&&currentBlock.type!=='thinking')
            stringKind='ignored'
          textKind=stringKind==='thinking'?'thinking'
            :stringKind==='argument'?'tool-call':'message'
          meta='';textBuffer='';textBytes=0;pendingHighSurrogate=''
          if(stringKind==='text'||stringKind==='thinking'||stringKind==='argument'){
            currentTextLeaf=nextTextLeaf++;textPieces=0
          }
          return
        }
        case 'endString':
          if(stringKind==='text'||stringKind==='thinking'||stringKind==='argument'){
            if(pendingHighSurrogate){
              const lone=pendingHighSurrogate
              pendingHighSurrogate=''
              const bytes=Buffer.byteLength(lone,'utf8')
              if(textBytes+bytes>FRAGMENT_BYTES)flushText()
              textBuffer+=lone
              textBytes+=bytes
            }
            flushText()
            if(textPieces>1){
              for(let i=0;i<fragments.length;i++){
                if(selectedLeafIds[i]===currentTextLeaf)fragments[i]!.splitScalar=true
              }
            }
          }
          else if(stringKind==='id')nativeEventId=meta
          else if(stringKind==='type')nativeType=meta
          else if(stringKind==='role')role=meta
          else if(stringKind==='resultCallId')resultCallId=meta
          else if(stringKind==='blockType'&&currentBlock)currentBlock.type=meta
          else if(stringKind==='blockId'&&currentBlock)currentBlock.id=meta
          stringKind='ignored'
          return
        case 'stringChunk':{
          const text=token.value
          if(inKey){
            keyBytes+=Buffer.byteLength(text,'utf8')
            if(keyBytes>MAX_KEY_BYTES){
              failed='native-record-key-budget'
              throw new Error(failed)
            }
            keyBuffer+=text
          }else if(stringKind==='text'||stringKind==='thinking'
            ||stringKind==='argument')writeText(text)
          else if(stringKind!=='ignored'){
            if(Buffer.byteLength(meta,'utf8')+Buffer.byteLength(text,'utf8')>MAX_META_BYTES){
              failed='native-record-metadata-budget'
              throw new Error(failed)
            }
            meta+=text
          }
          return
        }
        case 'startNumber':
        case 'nullValue':
        case 'trueValue':
        case 'falseValue':
          nextPath()
          return
        default:
          return
      }
    }

    async function* recordBytes(){
      let consumed=0
      while(consumed<span.rawByteLength){
        input.signal?.throwIfAborted()
        const requested=Math.min(CHUNK_BYTES,span.rawByteLength-consumed)
        const chunk=Buffer.allocUnsafe(requested)
        const {bytesRead}=await file.read(chunk,0,requested,span.offset+consumed)
        if(bytesRead!==requested){
          failed='native-record-changed-during-scan'
          throw new Error(failed)
        }
        const data=chunk.subarray(0,bytesRead)
        sha.update(data)
        const final=consumed+bytesRead===span.rawByteLength
        lineSha.update(final&&data.at(-1)===0x0d
          ?data.subarray(0,-1):data)
        consumed+=bytesRead
        yield data
      }
    }
    try{
      const stage=parser.asStream({
        packKeys:false,streamKeys:true,
        packStrings:false,streamStrings:true,
        packNumbers:false,streamNumbers:false,
      })
      for await(const token of Readable.from(recordBytes()).pipe(stage))
        onToken(token as Token)
    }catch(error){
      if(input.signal?.aborted)input.signal.throwIfAborted()
      return {state:failed==='native-record-changed-during-scan'?'drifted':'unsupported',
        reason:failed??'native-record-invalid-json'}
    }
    if(firstToken||stack.length!==0)return {state:'unsupported',reason:'native-record-invalid-json'}
    const current=await file.stat()
    if(sourceFileIdentity(current)!==span.fileIdentity
      ||current.size!==original.size||current.mtimeMs!==original.mtimeMs
      ||sha.digest('hex')!==span.sha256)
      return {state:'drifted',reason:'native-record-hash-changed'}
    const marker=Buffer.allocUnsafe(1)
    const tail=await file.read(marker,0,1,span.nextOffset-1)
    if(tail.bytesRead!==1||marker[0]!==0x0a)
      return {state:'drifted',reason:'native-record-boundary-changed'}
    if(fragmentOffset>totalTextFragments)
      return {state:'unsupported',reason:'invalid-fragment-window'}
    // Tool results live in another physical record. Match by exact native
    // ID while only exposing a hashed join key to fragment consumers.
    if(role==='tool'||role==='toolResult'){
      const callKey=resultCallId
        ?createHash('sha256').update(resultCallId).digest('hex'):undefined
      for(const fragment of fragments){
        if(fragment.kind!=='message')continue
        fragment.kind='tool-result'
        if(callKey)fragment.callKey=callKey
      }
    }
    return {state:'available',record:{
      offset:span.offset,fileIdentity:span.fileIdentity,
      recordSha256:span.sha256,sourceLineSha256:lineSha.digest('hex'),
      ...(nativeEventId?{nativeEventId}:{}),
      ...(nativeType?{nativeType}:{}),
      ...(role?{role}:{}),
      fragments,totalTextFragments,
      ...(fragmentOffset+fragments.length<totalTextFragments
        ?{nextFragmentOffset:fragmentOffset+fragments.length}:{}),
    }}
  }finally{await file.close()}
}
