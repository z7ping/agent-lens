import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { JSONParser, TokenType } from '@streamparser/json'
import { sourceFileIdentity } from './source-fs'
import {
  authorizeNativeSessionPath, inspectNativeSessionRecordSpan,
  type NativeSessionCursor,
} from './native-session-window'

const CHUNK_BYTES = 64 * 1024
const MAX_SCALAR_BYTES = 64 * 1024
const MAX_VISIBLE_TEXT_BYTES = 128 * 1024
const MAX_FRAGMENT_COUNT = 16
const MAX_FRAGMENT_OFFSET = 10_000_000

export interface NativeJsonlTextFragment {
  /** The ordinal of the recognized text leaf within ONE physical JSONL record. */
  ordinal: number
  text: string
}

export type NativeJsonlFragmentReadResult =
  | {
      state: 'available'
      /** Content is delivered only after whole-record JSON and SHA verification. */
      record: {
        offset: number
        fileIdentity: string
        recordSha256: string
        /** SHA of JSON record bytes excluding optional CR delimiter. */
        sourceLineSha256: string
        nativeEventId?: string
        nativeType?: string
        role?: string
        fragments: NativeJsonlTextFragment[]
        totalTextFragments: number
        /** Undefined only when the entire verified record has been enumerated. */
        nextFragmentOffset?: number
      }
    }
  | {state: 'pending' | 'unavailable' | 'drifted' | 'unsupported'; reason: string}

/** First, Source-authorize and verify a physical JSONL record; then parse a
 * restricted set of user-text leaves using the maintained streaming JSON
 * parser. No SourceRecord or complete message object is materialized.
 *
 * A single unbounded JSON string/object is NOT stream-splittable by this API:
 * it fails closed at 64KiB scalar budget rather than claiming partial facts.
 * Later review-only fragment consumers must use CapturePolicy before display.
 */
export async function readNativeJsonlTextFragments(input: {
  path: string
  allowedRoots: readonly string[]
  cursor?: NativeSessionCursor
  expectedSha256?: string
  fragmentOffset?: number
  limit?: number
  signal?: AbortSignal
}): Promise<NativeJsonlFragmentReadResult> {
  const fragmentOffset = input.fragmentOffset ?? 0
  const limit = input.limit ?? 8
  if (!Number.isSafeInteger(fragmentOffset) || fragmentOffset < 0
    || fragmentOffset > MAX_FRAGMENT_OFFSET
    || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FRAGMENT_COUNT) {
    return {state: 'unsupported', reason: 'invalid-fragment-window'}
  }
  const inspected = await inspectNativeSessionRecordSpan(input)
  if (inspected.state !== 'available') return inspected
  const {span} = inspected
  const authorized = await authorizeNativeSessionPath(input.path, input.allowedRoots)
  if (authorized.state !== 'authorized') return authorized
  const file = await open(authorized.sourcePath, 'r')
  try {
    const first = await file.stat()
    if (!first.isFile() || sourceFileIdentity(first) !== span.fileIdentity
      || first.size < span.nextOffset) {
      return {state:'drifted', reason:'native-record-changed-during-scan'}
    }
    const parser = new JSONParser({
      // Never retain whole message.content arrays or message objects.
      keepStack: false,
      paths: ['$.id', '$.type', '$.message.role',
        '$.message.content.*.text', '$.message.content.*.text.*'],
      emitPartialTokens: true,
      stringBufferSize: CHUNK_BYTES,
    })
    let nativeEventId: string | undefined
    let nativeType: string | undefined
    let role: string | undefined
    const fragments: NativeJsonlTextFragment[] = []
    let totalTextFragments = 0
    let selectedBytes = 0
    let scalarBudgetExceeded = false
    let rootIsObject = false
    let sawFirstToken = false

    parser.onToken = token => {
      if(!sawFirstToken){
        sawFirstToken=true
        rootIsObject=token.token===TokenType.LEFT_BRACE
        if(!rootIsObject)throw new Error('native-record-not-object')
      }
      // onToken fires for unfinished scalars on every bounded write().
      // Abort BEFORE a huge string can accumulate in the tokenizer.
      if (typeof token.value === 'string'
        && Buffer.byteLength(token.value, 'utf8') > MAX_SCALAR_BYTES) {
        scalarBudgetExceeded = true
        throw new Error('native-record-scalar-budget')
      }
    }
    parser.onValue = ({value, key, stack}) => {
      // Selectors are narrow; only scalar text content leaves are exposed.
      if (typeof value !== 'string') return
      const keys = [...stack.map(entry => entry.key), key].filter(v=>v!==undefined)
      if (keys.length===1 && keys[0]==='id') {
        if (value.length<=256) nativeEventId=value
      } else if (keys.length===1 && keys[0]==='type') {
        if (value.length<=100) nativeType=value
      } else if (keys.length===2 && keys[0]==='message'&&keys[1]==='role') {
        if (value.length<=80) role=value
      } else if (keys.includes('content') && keys.includes('text')) {
        const position=totalTextFragments++
        if (position < fragmentOffset || fragments.length >= limit) return
        const bytes=Buffer.byteLength(value,'utf8')
        if (bytes > MAX_SCALAR_BYTES || selectedBytes + bytes > MAX_VISIBLE_TEXT_BYTES) {
          scalarBudgetExceeded=true
          throw new Error('native-fragment-output-budget')
        }
        fragments.push({ordinal:position,text:value})
        selectedBytes+=bytes
      }
    }

    const hash=createHash('sha256')
    const lineHash=createHash('sha256')
    let consumed=0
    try {
      while(consumed<span.rawByteLength){
        input.signal?.throwIfAborted()
        const take=Math.min(CHUNK_BYTES,span.rawByteLength-consumed)
        const chunk=Buffer.allocUnsafe(take)
        const {bytesRead}=await file.read(chunk,0,take,span.offset+consumed)
        if(bytesRead!==take)return {state:'drifted',reason:'native-record-changed-during-scan'}
        const data=chunk.subarray(0,bytesRead)
        hash.update(data)
        const lastChunk=consumed+bytesRead===span.rawByteLength
        lineHash.update(lastChunk&&data.at(-1)===0x0d
          ?data.subarray(0,-1):data)
        parser.write(data)
        consumed+=bytesRead
      }
      parser.end()
    }catch(error){
      if (input.signal?.aborted) input.signal.throwIfAborted()
      return {state:'unsupported',reason:scalarBudgetExceeded
        ?'native-record-scalar-budget'
        :!rootIsObject&&sawFirstToken?'native-record-not-object'
        :'native-record-invalid-json'}
    }
    const last=await file.stat()
    if(sourceFileIdentity(last)!==span.fileIdentity
      ||last.size!==first.size||last.mtimeMs!==first.mtimeMs
      ||hash.digest('hex')!==span.sha256) {
      return {state:'drifted',reason:'native-record-hash-changed'}
    }
    // Verify the original physical terminator (the SHA covers the payload
    // and optional CR, not the newline byte).
    const terminator=Buffer.allocUnsafe(1)
    const tail=await file.read(terminator,0,1,span.nextOffset-1)
    if(tail.bytesRead!==1||terminator[0]!==0x0a)
      return {state:'drifted',reason:'native-record-boundary-changed'}
    return {state:'available',record:{
      offset:span.offset,fileIdentity:span.fileIdentity,recordSha256:span.sha256,
      sourceLineSha256:lineHash.digest('hex'),
      ...(nativeEventId?{nativeEventId}:{}),
      ...(nativeType?{nativeType}:{}),
      ...(role?{role}:{}),
      fragments,totalTextFragments,
      ...(fragmentOffset+fragments.length<totalTextFragments
        ?{nextFragmentOffset:fragmentOffset+fragments.length}:{}),
    }}
  }finally{await file.close()}
}
