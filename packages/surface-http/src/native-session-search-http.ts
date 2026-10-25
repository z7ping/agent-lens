import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  CapturePolicyService, NativeSessionCatalogEntry, NativeSessionCatalogQuery,
  NativeSessionCatalogStore, SourceNativeSessionCursor,
} from '@agent-lens/core'
import { nativeReviewObservationId, nativeReviewSessionId } from '@agent-lens/projection-review'
import { badRequest, writeJson } from './http-utils'
import type { NativeSessionWindowReader } from './native-session-http'

const PATH = '/api/v1/native-sessions/search'
const MAX_CURSOR = 4096
const PAGE_RECORDS = 16
const MAX_HITS = 64
const MAX_PAGE_BYTES = 2 * 1024 * 1024

type Before = NonNullable<NativeSessionCatalogQuery['before']>
type SearchCursor = {
  version: 1
  scopeHash: string
  before?: Before
  active?: { sourceId: string; installationId: string; nativeSessionId: string }
  sourceCursor?: SourceNativeSessionCursor
}

function beforeFor(entry: NativeSessionCatalogEntry): Before {
  return {
    sourceId: entry.sourceId, installationId: entry.installationId,
    nativeSessionId: entry.nativeSessionId, locationKind: entry.locationKind,
    lastActivityAt: entry.lastActivityAt,
  }
}

function validBefore(value: unknown): value is Before {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return Object.keys(row).length === 5
    && ['sourceId','installationId','nativeSessionId','lastActivityAt']
      .every(key => typeof row[key] === 'string' && row[key] !== '' && (row[key] as string).length <= 512)
    && (row.locationKind === 'native' || row.locationKind === 'archive')
}

function decode(value: string | null, scopeHash: string): SearchCursor | undefined {
  if (value === null) return undefined
  if (!value || value.length > MAX_CURSOR || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw badRequest('Invalid native body search cursor')
  }
  try {
    const data: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error()
    const cursor = data as Record<string, unknown>
    if (cursor.version !== 1 || cursor.scopeHash !== scopeHash
      || Object.keys(cursor).some(key => !['version','scopeHash','before','active','sourceCursor'].includes(key))
      || (cursor.before !== undefined && !validBefore(cursor.before))) throw new Error()
    if (cursor.active !== undefined) {
      const active = cursor.active as Record<string, unknown>
      if (!active || typeof active !== 'object' || Array.isArray(active)
        || Object.keys(active).length !== 3
        || !['sourceId','installationId','nativeSessionId'].every(key =>
          typeof active[key] === 'string' && (active[key] as string).length > 0
            && (active[key] as string).length <= 512)) throw new Error()
    }
    if (cursor.sourceCursor !== undefined) {
      if (!cursor.active) throw new Error()
      const sc = cursor.sourceCursor as Record<string,unknown>
      if (!sc || typeof sc !== 'object' || Array.isArray(sc)
        || ![3,4].includes(Object.keys(sc).length)
        || !Number.isSafeInteger(sc.offset) || (sc.offset as number) < 0
        || !Number.isSafeInteger(sc.sequence) || (sc.sequence as number) < 0
        || typeof sc.fileIdentity !== 'string' || !sc.fileIdentity
        || sc.fileIdentity.length > 128
        || (sc.boundaryHash !== undefined
          && (typeof sc.boundaryHash !== 'string' || !/^[0-9a-f]{64}$/.test(sc.boundaryHash)))) throw new Error()
    } else if (cursor.active) throw new Error()
    return cursor as SearchCursor
  } catch {
    throw badRequest('Invalid native body search cursor')
  }
}

function encode(value: SearchCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

/** Search only source-projected text fields, not raw JSON, path locators or attachments. */
function searchableText(value: unknown, depth = 0): string {
  if (depth > 4) return ''
  if (typeof value === 'string') return value.slice(0,8192)
  if (Array.isArray(value)) return value.slice(0,16).map(item=>searchableText(item,depth+1)).join(' ').slice(0,8192)
  if (!value || typeof value !== 'object') return ''
  const record=value as Record<string,unknown>
  return ['text','content','message','summary','prompt','parts','output','result','errorMessage']
    .map(key=>record[key] === undefined ? '' : searchableText(record[key],depth+1))
    .filter(Boolean).join(' ').slice(0,8192)
}

function excerpt(text: string, index: number, length: number): string {
  const start=Math.max(0,index-48)
  return (start ? '…' : '')+text.slice(start,Math.min(text.length,index+length+96))
    +(index+length+96<text.length ? '…' : '')
}

/**
 * One Catalog session and one Source page per HTTP request. The continuation
 * binds the search scope and preserves the Source-owned record cursor.
 * Clients must keep paging: an empty page never proves the corpus has no hits.
 */
export async function handleNativeSessionBodySearchRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  catalog?: NativeSessionCatalogStore,
  reader?: NativeSessionWindowReader,
  policy?: CapturePolicyService,
): Promise<boolean> {
  if (url.pathname !== PATH) return false
  if (request.method !== 'GET') {
    response.setHeader('allow','GET')
    writeJson(response,405,{error:'method_not_allowed'})
    return true
  }
  if (!catalog || !reader || !policy) {
    writeJson(response,503,{state:'unavailable',reason:'native-search-unavailable'})
    return true
  }
  if ([...url.searchParams.keys()].some(key=>!['q','sourceId','cursor'].includes(key))
    || url.searchParams.getAll('q').length!==1
    || url.searchParams.getAll('sourceId').length>1
    || url.searchParams.getAll('cursor').length>1) {
    throw badRequest('Invalid native search parameters')
  }
  const query=url.searchParams.get('q')?.trim() ?? ''
  const sourceId=url.searchParams.get('sourceId')?.trim() ?? ''
  if (query.length<2 || query.length>120 || query.includes('\0')
    || sourceId.length>512 || (url.searchParams.has('sourceId') && !sourceId)) {
    throw badRequest('Invalid native search scope')
  }
  if (sourceId && !policy.isSourceEnabled(sourceId)) {
    writeJson(response,200,{
      state:'available',coverage:'bounded',items:[],scannedSessions:0,scannedObservations:0,
      hasMore:false,pendingTail:false,
    })
    return true
  }
  const needle=query.toLocaleLowerCase()
  const scopeHash=createHash('sha256').update(JSON.stringify([needle,sourceId])).digest('hex')
  const cursor=decode(url.searchParams.get('cursor'),scopeHash)
  const page=await catalog.query({
    limit:1,onlyWithoutLegacyReview:true,
    ...(sourceId ? {sourceId} : {}),
    ...(cursor?.before ? {before:cursor.before} : {}),
  })
  const entry=page.items[0]
  if (!entry) {
    if (cursor?.active) {
      writeJson(response,200,{state:'drifted',reason:'native-search-catalog-session-changed'})
    } else {
      writeJson(response,200,{
        state:'available',coverage:'bounded',items:[],
        scannedSessions:0,scannedObservations:0,hasMore:false,pendingTail:false,
      })
    }
    return true
  }
  if (cursor?.active && (
    entry.sourceId!==cursor.active.sourceId
    || entry.installationId!==cursor.active.installationId
    || entry.nativeSessionId!==cursor.active.nativeSessionId
  )) {
    writeJson(response,200,{state:'drifted',reason:'native-search-catalog-session-changed'})
    return true
  }
  const abort=new AbortController()
  const close=()=>{if(!response.writableEnded)abort.abort()}
  response.once('close',close)
  try {
    const authorized=policy.isSourceEnabled(entry.sourceId)
    const scanned=authorized
      ? await reader.read({
        sourceId:entry.sourceId,installationId:entry.installationId,
        nativeSessionId:entry.nativeSessionId,limit:PAGE_RECORDS,
        ...(cursor?.sourceCursor ? {cursor:cursor.sourceCursor} : {}),
        signal:abort.signal,
      })
      : null
    if (abort.signal.aborted || response.destroyed) return true
    if (scanned && scanned.state!=='available') {
      writeJson(response,200,scanned)
      return true
    }
    const items:Array<{
      sessionId:string;sourceId:string;installationId:string;nativeSessionId:string;
      observationId:string;kind:string;at:string;excerpt:string
    }>=[]
    let inputBytes=0
    const occurrences=new Map<string,number>()
    for(let i=0;scanned && i<scanned.observations.length;i++){
      const observation=scanned.observations[i]!
      const id=scanned.observationRecordIds[i]!
      const ordinal=occurrences.get(id)??0
      occurrences.set(id,ordinal+1)
      if (!observation.kind.startsWith('message.') && observation.kind!=='tool.result'
        && observation.kind!=='tool.call') continue
      const text=searchableText(observation.payload)
      inputBytes+=Buffer.byteLength(text,'utf8')
      if(inputBytes>MAX_PAGE_BYTES) {
        writeJson(response,200,{state:'unsupported',reason:'native-search-input-budget'})
        return true
      }
      const match=text.toLocaleLowerCase().indexOf(needle)
      if(match<0)continue
      if(items.length>=MAX_HITS){
        writeJson(response,200,{state:'unsupported',reason:'native-search-matches-budget'})
        return true
      }
      items.push({
        sessionId:nativeReviewSessionId(entry.sourceId,entry.installationId,entry.nativeSessionId),
        sourceId:entry.sourceId,installationId:entry.installationId,nativeSessionId:entry.nativeSessionId,
        observationId:nativeReviewObservationId(entry.sourceId,entry.installationId,
          entry.nativeSessionId,observation,id,ordinal),
        kind:observation.kind,at:observation.occurredAt??observation.capturedAt,
        excerpt:excerpt(text,match,query.length),
      })
    }
    const pendingTail=scanned?.pendingTail??false
    const continuing=Boolean(scanned?.hasMore||pendingTail)
    const hasMore=continuing||page.hasMore
    const nextCursor=hasMore ? encode({
      version:1,scopeHash,
      ...(continuing ? {
        ...(cursor?.before ? {before:cursor.before} : {}),
        active:{sourceId:entry.sourceId,installationId:entry.installationId,nativeSessionId:entry.nativeSessionId},
        sourceCursor:scanned!.nextCursor,
      } : {before:beforeFor(entry)}),
    }) : undefined
    if(nextCursor && nextCursor.length>MAX_CURSOR) {
      writeJson(response,200,{state:'unsupported',reason:'native-search-cursor-budget'})
      return true
    }
    writeJson(response,200,{
      state:'available',coverage:'bounded',items,
      scannedSessions:1,scannedObservations:scanned?.observations.length??0,
      hasMore,pendingTail,...(nextCursor?{nextCursor}:{}),
    })
    return true
  } finally {
    response.off('close',close)
  }
}
