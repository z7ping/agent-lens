import { createHash } from 'node:crypto'
import { open, realpath, type FileHandle } from 'node:fs/promises'
import { extname, isAbsolute, relative } from 'node:path'
import { sourceFileIdentity } from './source-fs'

/** Cursor is transient positioning metadata, not a durable copy of event content. */
export interface NativeSessionCursor {
  offset: number
  sequence: number
  fileIdentity: string
  /** SHA-256 over the bounded bytes preceding this read boundary. */
  boundaryHash?: string
}

export interface NativeSessionLine {
  entry: Record<string, unknown>
  textFingerprint: string
  boundaryHash: string
  offset: number
  sequence: number
}

export type NativeSessionWindowResult =
  | {
      state: 'available'
      lines: NativeSessionLine[]
      nextCursor: NativeSessionCursor
      hasMore: boolean
      /** A partial, unterminated tail is never delivered or skipped. */
      pendingTail: boolean
    }
  | { state: 'unavailable' | 'drifted' | 'unsupported'; reason: string }

const CHUNK_BYTES = 64 * 1024
const MAX_RECORD_BYTES = 2 * 1024 * 1024
const MAX_WINDOW_BYTES = 8 * 1024 * 1024
const MAX_WINDOW_RECORDS = 64
const CURSOR_BOUNDARY_BYTES = 256

async function hashAtBoundary(file: FileHandle, offset: number): Promise<string> {
  const length = Math.min(CURSOR_BOUNDARY_BYTES, offset)
  const buffer = Buffer.alloc(length)
  if (length) {
    const { bytesRead } = await file.read(buffer, 0, length, offset - length)
    if (bytesRead !== length) throw new Error('Native file changed during boundary verification')
  }
  return createHash('sha256').update(buffer).digest('hex')
}

function inside(root: string, child: string): boolean {
  const rel = relative(root, child)
  return (rel === '' || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel)))
}

type NativePathAuthorization =
  | { state:'authorized';sourcePath:string }
  | { state:'unavailable'|'unsupported';reason:string }

/** Both the ordinary reader and the oversized-record inspector use the
 * same Source-owned realpath / allowedRoots authorization. */
async function authorizeNativeSessionPath(
  path:string,allowedRoots:readonly string[],
):Promise<NativePathAuthorization>{
  let sourcePath:string
  try{sourcePath=await realpath(path)}catch(error){
    const code=(error as NodeJS.ErrnoException).code
    if(code==='ENOENT')return {state:'unavailable',reason:'native-file-missing'}
    if(code==='EACCES'||code==='EPERM')return {state:'unavailable',reason:'native-file-not-readable'}
    throw error
  }
  let allowed=false
  for(const root of allowedRoots){
    if(!root||!isAbsolute(root))continue
    try{
      if(inside(await realpath(root),sourcePath)){allowed=true;break}
    }catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error
    }
  }
  return allowed?{state:'authorized',sourcePath}
    :{state:'unsupported',reason:'source-path-not-authorized'}
}

const MAX_RECORD_SPAN_SCAN_BYTES=64*1024*1024

export type NativeSessionRecordSpanResult =
  | {
      state:'available'
      /** Physical byte evidence ONLY: JSON syntax and semantic facts are NOT
       * validated. Never use nextOffset as an ingestion / Review cursor until
       * a Source parser has certified the entire logical record. */
      span:{
        offset:number
        nextOffset:number
        rawByteLength:number
        sha256:string
        fileIdentity:string
        boundaryHash:string
        endBoundaryHash:string
        oversized:boolean
      }
    }
  | {state:'pending';reason:'native-record-pending-tail'}
  | {state:'unavailable'|'drifted'|'unsupported';reason:string}

/** Inspect exactly ONE physical JSONL record using at most 64KiB of payload
 * memory. The resulting hash and boundaries can support future token-based
 * fragments, but do not mean a giant JSON object has been parsed.
 */
export async function inspectNativeSessionRecordSpan(input:{
  path:string
  allowedRoots:readonly string[]
  cursor?:NativeSessionCursor
  expectedSha256?:string
  signal?:AbortSignal
}):Promise<NativeSessionRecordSpanResult>{
  if(!isAbsolute(input.path)||extname(input.path).toLowerCase()!=='.jsonl'
    || (input.cursor&&(!Number.isSafeInteger(input.cursor.offset)||input.cursor.offset<0
      || !Number.isSafeInteger(input.cursor.sequence)||input.cursor.sequence<0
      || !input.cursor.fileIdentity
      || (input.cursor.boundaryHash!==undefined
        && !/^[0-9a-f]{64}$/.test(input.cursor.boundaryHash))))
    || (input.expectedSha256!==undefined&&!/^[0-9a-f]{64}$/.test(input.expectedSha256))){
    return {state:'unsupported',reason:'invalid-window-reference'}
  }
  input.signal?.throwIfAborted()
  const authorization=await authorizeNativeSessionPath(input.path,input.allowedRoots)
  if(authorization.state!=='authorized')return authorization
  const file=await open(authorization.sourcePath,'r')
  try{
    const initial=await file.stat()
    if(!initial.isFile())return {state:'unsupported',reason:'native-source-is-not-a-file'}
    const fileIdentity=sourceFileIdentity(initial)
    const offset=input.cursor?.offset??0
    if(input.cursor&&input.cursor.fileIdentity!==fileIdentity)
      return {state:'drifted',reason:'native-file-identity-changed'}
    if(offset>initial.size)return {state:'drifted',reason:'native-file-shrank'}
    if(offset>0){
      const previous=Buffer.alloc(1)
      const n=await file.read(previous,0,1,offset-1)
      if(n.bytesRead!==1||previous[0]!==0x0a)
        return {state:'drifted',reason:'native-cursor-not-line-aligned'}
    }
    const boundaryHash=await hashAtBoundary(file,offset)
    if(input.cursor?.boundaryHash&&input.cursor.boundaryHash!==boundaryHash)
      return {state:'drifted',reason:'native-cursor-boundary-changed'}
    const hash=createHash('sha256')
    let scanned=0
    let lastByte:number|undefined
    while(scanned<=MAX_RECORD_SPAN_SCAN_BYTES){
      input.signal?.throwIfAborted()
      const chunk=Buffer.allocUnsafe(Math.min(CHUNK_BYTES,MAX_RECORD_SPAN_SCAN_BYTES+1-scanned))
      const {bytesRead}=await file.read(chunk,0,chunk.length,offset+scanned)
      if(!bytesRead)return {state:'pending',reason:'native-record-pending-tail'}
      const newline=chunk.subarray(0,bytesRead).indexOf(0x0a)
      const length=newline<0?bytesRead:newline
      const part=chunk.subarray(0,length)
      hash.update(part)
      if(length)lastByte=part[length-1]
      scanned+=length
      if(newline>=0){
        const final=await file.stat()
        if(!final.isFile()||sourceFileIdentity(final)!==fileIdentity
          ||final.size!==initial.size||final.mtimeMs!==initial.mtimeMs
          ||await hashAtBoundary(file,offset)!==boundaryHash){
          return {state:'drifted',reason:'native-record-changed-during-scan'}
        }
        const digest=hash.digest('hex')
        if(input.expectedSha256&&input.expectedSha256!==digest)
          return {state:'drifted',reason:'native-record-hash-changed'}
        const endOffset=offset+scanned+1
        return {state:'available',span:{
          offset,nextOffset:endOffset,rawByteLength:scanned,sha256:digest,
          fileIdentity,boundaryHash,endBoundaryHash:await hashAtBoundary(file,endOffset),
          oversized:scanned-(lastByte===0x0d?1:0)>MAX_RECORD_BYTES,
        }}
      }
      if(scanned>MAX_RECORD_SPAN_SCAN_BYTES)
        return {state:'unsupported',reason:'native-record-span-budget'}
    }
    return {state:'unsupported',reason:'native-record-span-budget'}
  }finally{await file.close()}
}

/**
 * Read a bounded JSONL page directly from a Source-owned native file, without
 * any database checkpoints, Canonical writes, or whole-session in-memory scan.
 * Only trusted server-side catalog locators may reach this function.
 */
export async function readNativeSessionWindow(input: {
  path: string
  allowedRoots: readonly string[]
  cursor?: NativeSessionCursor
  limit?: number
  signal?: AbortSignal
}): Promise<NativeSessionWindowResult> {
  const { signal } = input
  const limit = input.limit ?? 32
  if (!isAbsolute(input.path) || extname(input.path).toLowerCase() !== '.jsonl'
    || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_WINDOW_RECORDS
    || (input.cursor && (!Number.isSafeInteger(input.cursor.offset) || input.cursor.offset < 0
      || !Number.isSafeInteger(input.cursor.sequence) || input.cursor.sequence < 0
      || !input.cursor.fileIdentity
      || (input.cursor.boundaryHash !== undefined
        && !/^[0-9a-f]{64}$/.test(input.cursor.boundaryHash))))) {
    return { state: 'unsupported', reason: 'invalid-window-reference' }
  }
  signal?.throwIfAborted()
  const authorization=await authorizeNativeSessionPath(input.path,input.allowedRoots)
  if(authorization.state!=='authorized')return authorization
  const file = await open(authorization.sourcePath, 'r')
  try {
    const current = await file.stat()
    if (!current.isFile()) return { state: 'unsupported', reason: 'native-source-is-not-a-file' }
    const fileIdentity = sourceFileIdentity(current)
    const offset = input.cursor?.offset ?? 0
    if (input.cursor && input.cursor.fileIdentity !== fileIdentity) {
      return { state: 'drifted', reason: 'native-file-identity-changed' }
    }
    if (offset > current.size) return { state: 'drifted', reason: 'native-file-shrank' }
    if (offset > 0) {
      const previous = Buffer.alloc(1)
      const read = await file.read(previous, 0, 1, offset - 1)
      if (read.bytesRead !== 1 || previous[0] !== 0x0a) {
        return { state: 'drifted', reason: 'native-cursor-not-line-aligned' }
      }
    }
    // Once the position is a valid line boundary, verify the preceding bytes.
    // The stronger fingerprint still detects same-inode overwritten records.
    if (input.cursor?.boundaryHash
      && await hashAtBoundary(file, offset) !== input.cursor.boundaryHash) {
      return { state: 'drifted', reason: 'native-cursor-boundary-changed' }
    }
    const lines: NativeSessionLine[] = []
    let bytesReadInWindow = 0
    let start = offset
    let sequence = input.cursor?.sequence ?? 0
    // Keep only bounded references to unread chunks. Repeated Buffer.concat
    // on every 64KiB read recopies a long JSONL record many times.
    let pendingChunks: Buffer[] = []
    let pendingBytes = 0
    let pendingTail = false

    while (lines.length < limit && bytesReadInWindow < MAX_WINDOW_BYTES) {
      signal?.throwIfAborted()
      const length = Math.min(CHUNK_BYTES, MAX_WINDOW_BYTES - bytesReadInWindow)
      const chunk = Buffer.allocUnsafe(length)
      const { bytesRead } = await file.read(chunk, 0, length, offset + bytesReadInWindow)
      if (bytesRead === 0) {
        pendingTail = pendingBytes > 0
        break
      }
      bytesReadInWindow += bytesRead
      let position = 0
      while (lines.length < limit && position < bytesRead) {
        const newline = chunk.indexOf(0x0a, position)
        if (newline === -1 || newline >= bytesRead) {
          const remainder = chunk.subarray(position, bytesRead)
          pendingChunks.push(remainder)
          pendingBytes += remainder.length
          break
        }
        const part = chunk.subarray(position, newline)
        const rawBytes = pendingBytes + part.length
        // Allow a trailing CR before stripping it, but never concatenate an
        // unbounded record or silently skip a physical SourceRecord.
        if (rawBytes > MAX_RECORD_BYTES + 1) {
          return { state: 'unsupported', reason: 'native-record-too-large' }
        }
        let raw = pendingBytes
          ? Buffer.concat([...pendingChunks, part], rawBytes)
          : part
        if (raw.length && raw[raw.length - 1] === 0x0d) raw = raw.subarray(0, -1)
        if (raw.length > MAX_RECORD_BYTES) {
          return { state: 'unsupported', reason: 'native-record-too-large' }
        }
        const lineEnd = start + rawBytes + 1
        const text = raw.toString('utf8')
        let entry: unknown
        if (text.trim()) {
          try {
            entry = JSON.parse(text.replace(/^\uFEFF/, ''))
          } catch {
            return { state: 'unsupported', reason: 'native-invalid-json' }
          }
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return { state: 'unsupported', reason: 'native-record-not-object' }
          }
        }
        sequence++
        if (entry) lines.push({
          entry: entry as Record<string, unknown>,
          boundaryHash: await hashAtBoundary(file, start),
          textFingerprint: createHash('sha256').update(text).digest('hex'),
          offset: start,
          sequence,
        })
        pendingChunks = []
        pendingBytes = 0
        start = lineEnd
        position = newline + 1
      }
      if (pendingBytes > MAX_RECORD_BYTES + 2) {
        return { state: 'unsupported', reason: 'native-record-too-large' }
      }
    }
    if (bytesReadInWindow >= MAX_WINDOW_BYTES && lines.length === 0 && pendingBytes) {
      return { state: 'unsupported', reason: 'native-window-byte-limit' }
    }
    signal?.throwIfAborted()
    // Do not advance past an incomplete tail (or past a lookahead in a full chunk).
    return {
      state: 'available',
      lines,
      nextCursor: {
        offset: start, sequence, fileIdentity,
        boundaryHash: await hashAtBoundary(file, start),
      },
      hasMore: start < current.size && (lines.length >= limit || pendingBytes > 0 || bytesReadInWindow >= MAX_WINDOW_BYTES),
      pendingTail: pendingTail || (start < current.size && lines.length < limit && bytesReadInWindow < MAX_WINDOW_BYTES),
    }
  } finally {
    await file.close()
  }
}
