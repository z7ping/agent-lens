import type { IncomingMessage, ServerResponse } from 'node:http'
import { realpath, stat } from 'node:fs/promises'
import { sourceFileIdentity } from '@agent-lens/source-support'
import type {
  CapturePolicyService, NativeSessionCatalogEntry, NativeSessionCatalogStore,
  SourceNativeSessionCursor, SourceService,
} from '@agent-lens/core'
import type { NativeReviewTurnIndexResponseDto } from '@agent-lens/protocol'
import { badRequest, writeJson } from './http-utils'
import {
  encodeNativeSessionCursor, type NativeSessionWindowReader,
} from './native-session-http'

/**
 * Sparse turn locator metadata lives in the existing Slim checkpoint store:
 * no new schema, payload copies, old event index or startup migration.
 * One checkpoint block holds <=64 turn boundaries. Its state is committed
 * after blocks, so a crash can only cause idempotent replay.
 */
export interface NativeTurnIndexCheckpointStore {
  get<T>(scope: string, key: string): Promise<T | null>
  set<T>(scope: string, key: string, value: T): Promise<void>
}

interface NativeTurnLocator {
  ordinal: number
  cursor: SourceNativeSessionCursor
  nativeEventId?: string
  at?: string
}
interface NativeTurnIndexState {
  version: 1
  fileIdentity: string
  parserVersion: string
  fileSize: number
  fileMtimeMs: number
  nextCursor?: SourceNativeSessionCursor
  knownTurns: number
  complete: boolean
}
const SCOPE = 'native-review-turn-index-v1'
const BLOCK_SIZE = 64
const INITIAL_SOURCE_PAGE_SIZE = 16
const CONTINUATION_SOURCE_PAGE_SIZE = 64
const PAGES_PER_SCAN = 12
const MAX_INDEX_QUERY = 120
const MAX_INDEX_ORDINAL = 10_000_000

function stateKey(id: string): string { return id + ':state' }
function blockKey(id: string, block: number): string { return id + ':block:' + block }
function sameRevision(state: NativeTurnIndexState, entry: NativeSessionCatalogEntry, parserVersion: string): boolean {
  return state.version === 1
    && state.fileIdentity === entry.fileIdentity
    && state.parserVersion === parserVersion
    && Number.isSafeInteger(state.knownTurns) && state.knownTurns >= 0
    && state.knownTurns <= MAX_INDEX_ORDINAL
    && Number.isSafeInteger(state.fileSize) && state.fileSize >= 0
    && Number.isFinite(state.fileMtimeMs)
    // Append-only growth is valid; shrink, replacement or in-place edits are not.
    && (entry.fileSize > state.fileSize
      || (entry.fileSize === state.fileSize && entry.fileMtimeMs === state.fileMtimeMs))
}

export class NativeReviewTurnIndex {
  private readonly scans = new Map<string, Promise<void>>()
  constructor(
    private readonly reader: NativeSessionWindowReader,
    private readonly catalog: Pick<NativeSessionCatalogStore,'getByReviewSessionId'>,
    private readonly checkpoints: NativeTurnIndexCheckpointStore,
    private readonly sources: SourceService,
    private readonly policy: CapturePolicyService,
  ) {}

  private async scan(
    id: string, entry: NativeSessionCatalogEntry, parserVersion: string,
    previous: NativeTurnIndexState,
  ): Promise<void> {
    // Coalesce concurrent readers on a given native session. Never keep an
    // unbounded normalized source page or source payload between requests.
    const signal = AbortSignal.timeout(12_000)
    let state = { ...previous }
    let cursor = state.nextCursor
    // A scan can revisit the same 64-turn block on many consecutive pages.
    // Cache only blocks touched by this bounded scan, not the session history.
    const blockCache = new Map<number, NativeTurnLocator[]>()
    // Return the first partial index quickly; subsequent calls use the existing
    // 64-record Source limit to fill the remaining index with fewer IPC hops.
    // Neither mode reads entire session content into memory.
    const pageSize = state.nextCursor ? CONTINUATION_SOURCE_PAGE_SIZE : INITIAL_SOURCE_PAGE_SIZE
    for (let pageIndex = 0; pageIndex < PAGES_PER_SCAN; pageIndex++) {
      signal.throwIfAborted()
      const result = await this.reader.read({
        sourceId: entry.sourceId, installationId: entry.installationId,
        nativeSessionId: entry.nativeSessionId,
        ...(cursor ? {cursor} : {}), limit: pageSize, signal,
      })
      if (result.state !== 'available') {
        // Keep the old checkpoint but never return stale locators as complete.
        // The next request can retry after Source/Catalog resynchronization.
        if (result.state === 'drifted') {
          await this.checkpoints.set(SCOPE,stateKey(id),{
            version:1, fileIdentity:'drifted',parserVersion,
            fileSize:0,fileMtimeMs:0,knownTurns:0,complete:false,
          } satisfies NativeTurnIndexState)
        }
        throw new Error(result.reason)
      }
      if (result.observations.length !== result.observationRecordIds.length
        || !result.observationCursors
        || result.observationCursors.length !== result.observations.length) {
        throw new Error('native-review-index-record-boundaries-unavailable')
      }
      const additions:NativeTurnLocator[] = []
      const seen = new Set<number>()
      for (let index = 0; index < result.observations.length; index++) {
        if (result.observations[index]?.kind !== 'message.user') continue
        const rewind = result.observationCursors[index]!
        if (rewind.fileIdentity !== entry.fileIdentity
          || !Number.isSafeInteger(rewind.offset) || rewind.offset < (cursor?.offset ?? 0)
          || rewind.offset >= result.nextCursor.offset
          || !Number.isSafeInteger(rewind.sequence) || rewind.sequence < 0) {
          throw new Error('native-review-index-record-drifted')
        }
        if (seen.has(rewind.offset)) continue
        seen.add(rewind.offset)
        const ordinal = state.knownTurns + additions.length + 1
        if (ordinal > MAX_INDEX_ORDINAL) throw new Error('native-review-index-ordinal-budget')
        const observation = result.observations[index]!
        // Native identity may join Live/Review; their ordinals remain
        // independent because the original file may contain other branches.
        const nativeEventId = typeof observation.nativeEventId === 'string'
          && observation.nativeEventId.length > 0 && observation.nativeEventId.length <= 256
          ? observation.nativeEventId : undefined
        additions.push({
          ordinal, cursor:rewind,
          ...(nativeEventId ? {nativeEventId} : {}),
          ...(observation.occurredAt ? {at:observation.occurredAt} : {}),
        })
      }
      // A checkpoint block is a bounded sparse index, never a JSONL copy.
      const grouped=new Map<number,NativeTurnLocator[]>()
      for(const locator of additions){
        const block=Math.floor((locator.ordinal-1)/BLOCK_SIZE)
        const existing=grouped.get(block)??[]
        existing.push(locator)
        grouped.set(block,existing)
      }
      for(const [block,locators] of grouped){
        const key=blockKey(id,block)
        let existing=blockCache.get(block)
        if (!existing) {
          existing=await this.checkpoints.get<NativeTurnLocator[]>(SCOPE,key)??[]
          blockCache.set(block,existing)
        }
        const prefix=existing.filter(item=>
          item.ordinal >= block*BLOCK_SIZE+1 && item.ordinal < locators[0]!.ordinal)
        const committed=[...prefix,...locators]
        await this.checkpoints.set(SCOPE,key,committed)
        blockCache.set(block,committed)
      }
      // State is stored last; a crash may replay exactly this page, but never
      // publish uncommitted locators or fabricate totalRounds.
      if (result.nextCursor.offset <= (cursor?.offset ?? -1) && result.hasMore) {
        throw new Error('native-review-index-cursor-not-advancing')
      }
      state = {
        ...state,
        nextCursor:result.nextCursor,
        knownTurns:state.knownTurns + additions.length,
        complete:!result.hasMore && !result.pendingTail,
        fileIdentity:entry.fileIdentity, parserVersion,
        fileSize:entry.fileSize, fileMtimeMs:entry.fileMtimeMs,
      }
      await this.checkpoints.set(SCOPE,stateKey(id),state)
      cursor = result.nextCursor
      if (!result.hasMore || result.pendingTail) break
    }
  }

  /** Find a native user entry anywhere in a COMPLETE sparse metadata index,
   * not just near the Live ordinal. Verify the live and Source file paths are
   * the same physical file and refuse stale/incomplete/duplicate identities.
   * A scan of checkpoint blocks never hydrates event bodies.
   */
  async findByNativeEventId(
    id:string,nativeEventId:string,liveFilePath:string,
  ):Promise<{ordinal:number;cursor:string;nativeEventId:string}|undefined>{
    if(!/^native:[a-f0-9]{32}$/.test(id)
      || !nativeEventId || nativeEventId.length>256
      || !liveFilePath || liveFilePath.length>4096)return undefined
    const status=await this.query(id,{tail:1})
    if(status.state!=='available'||status.coverage!=='complete')return undefined
    const entry=await this.catalog.getByReviewSessionId(id)
    if(!entry||entry.locationKind!=='native'||!this.policy.isSourceEnabled(entry.sourceId))return undefined
    const source=this.sources.list().find(value=>value.manifest.sourceId===entry.sourceId)
    if(!source?.readNativeSessionPage)return undefined
    const original=await this.checkpoints.get<NativeTurnIndexState>(SCOPE,stateKey(id))
    if(!original||!original.complete||!sameRevision(original,entry,source.manifest.parserVersion)
      || original.fileSize!==entry.fileSize||original.fileMtimeMs!==entry.fileMtimeMs)return undefined
    const checkLiveFile=async()=>{
      try{
        const [sourcePath,livePath,file]=await Promise.all([
          realpath(entry.filePath),realpath(liveFilePath),stat(entry.filePath),
        ])
        return sourcePath===livePath&&file.isFile()
          && sourceFileIdentity(file)===entry.fileIdentity
          && file.size===entry.fileSize&&file.mtimeMs===entry.fileMtimeMs
      }catch{return false}
    }
    if(!await checkLiveFile())return undefined
    let matched:NativeTurnLocator|undefined
    // All known IDs must be inspected before accepting uniqueness; otherwise
    // an inactive branch can contain a duplicate outside the nearby window.
    // Batches cap both active heap and checkpoint read concurrency.
    const totalBlocks=Math.ceil(original.knownTurns/BLOCK_SIZE)
    for(let startBlock=0;startBlock<totalBlocks;startBlock+=16){
      const blocks=await Promise.all(Array.from({
        length:Math.min(16,totalBlocks-startBlock),
      },(_,i)=>this.checkpoints.get<NativeTurnLocator[]>(SCOPE,blockKey(id,startBlock+i))))
      for(let i=0;i<blocks.length;i++){
        const block=blocks[i]
        if(!block||!Array.isArray(block))return undefined
        for(const item of block){
          if(item.ordinal<(startBlock+i)*BLOCK_SIZE+1
            ||item.ordinal>(startBlock+i+1)*BLOCK_SIZE
            ||item.ordinal>original.knownTurns
            ||item.cursor.fileIdentity!==entry.fileIdentity)return undefined
          if(item.nativeEventId!==nativeEventId)continue
          if(matched)return undefined
          matched=item
        }
      }
    }
    if(!matched||!await checkLiveFile())return undefined
    const latest=await this.checkpoints.get<NativeTurnIndexState>(SCOPE,stateKey(id))
    if(!latest||!latest.complete||latest.knownTurns!==original.knownTurns
      ||latest.fileIdentity!==original.fileIdentity
      ||latest.fileSize!==original.fileSize
      ||latest.fileMtimeMs!==original.fileMtimeMs
      ||latest.nextCursor?.offset!==original.nextCursor?.offset)return undefined
    return {
      ordinal:matched.ordinal,nativeEventId,
      cursor:encodeNativeSessionCursor({
        ...matched.cursor,mode:'review-turns',turnOrdinal:matched.ordinal,
      }),
    }
  }

  async query(id:string, options:{ordinal?:number;tail?:number;from?:number;around?:number;limit?:number;scan?:boolean;expectedNativeEventId?:string}):Promise<NativeReviewTurnIndexResponseDto> {
    if (!/^native:[a-f0-9]{32}$/.test(id)) return {state:'unavailable',reason:'native-session-invalid'}
    const entry = await this.catalog.getByReviewSessionId(id)
    if (!entry || entry.locationKind!=='native') return {state:'unavailable',reason:'native-session-not-indexed'}
    if (!this.policy.isSourceEnabled(entry.sourceId)) return {state:'unsupported',reason:'source-disabled'}
    const source = this.sources.list().find(value => value.manifest.sourceId === entry.sourceId)
    if (!source?.readNativeSessionPage) return {state:'unsupported',reason:'native-window-unsupported-by-source'}
    const parserVersion = source.manifest.parserVersion
    let state = await this.checkpoints.get<NativeTurnIndexState>(SCOPE,stateKey(id))
    if (!state || !sameRevision(state,entry,parserVersion)) {
      state = {
        version:1,fileIdentity:entry.fileIdentity,parserVersion,
        fileSize:entry.fileSize,fileMtimeMs:entry.fileMtimeMs,
        knownTurns:0,complete:false,
      }
      // Invalidation is explicit; old block data is ignored beyond knownTurns.
      await this.checkpoints.set(SCOPE,stateKey(id),state)
    } else if (entry.fileSize > state.fileSize) {
      // A growing original source invalidates the prior EOF claim immediately.
      // Keep its verified prefix and resume indexing from its last cursor.
      state={...state,complete:false,fileSize:entry.fileSize,fileMtimeMs:entry.fileMtimeMs}
      await this.checkpoints.set(SCOPE,stateKey(id),state)
    }
    if (options.scan && (!state.complete || entry.fileSize > (state.nextCursor?.offset ?? 0))) {
      const existing = this.scans.get(id)
      if (existing) {
        try{await existing}catch(error){
          return {state:'unsupported',reason:error instanceof Error?error.message:'native-review-index-scan-failed'}
        }
      } else {
        const task=this.scan(id,entry,parserVersion,state).finally(()=>this.scans.delete(id))
        this.scans.set(id,task)
        try{await task}catch(error){
          return {state:'unsupported',reason:error instanceof Error?error.message:'native-review-index-scan-failed'}
        }
      }
      state = await this.checkpoints.get<NativeTurnIndexState>(SCOPE,stateKey(id)) ?? state
    }
    const knownTurns=state.knownTurns
    const limit=Math.min(MAX_INDEX_QUERY,
      options.ordinal?1:options.tail??options.limit??MAX_INDEX_QUERY)
    const start=options.ordinal ?? options.from ?? (options.around
      ?Math.max(1,Math.min(Math.max(1,knownTurns-limit+1),
        options.around-Math.floor(limit/2)))
      :Math.max(1,knownTurns-limit+1))
    const items:Extract<NativeReviewTurnIndexResponseDto,{state:'available'}>['items'] = []
    if (start<=knownTurns) {
      const end=Math.min(knownTurns,start+limit-1)
      for(let ordinal=start;ordinal<=end;) {
        const block=Math.floor((ordinal-1)/BLOCK_SIZE)
        const entries=await this.checkpoints.get<NativeTurnLocator[]>(SCOPE,blockKey(id,block))??[]
        for (const item of entries) {
          if(item.ordinal<ordinal || item.ordinal>end)continue
          if(item.cursor.fileIdentity!==entry.fileIdentity)continue
          // A numeric offset alone is not enough when different native
          // history views (or branches) enumerate turns differently.
          if(options.expectedNativeEventId!==undefined
            && item.nativeEventId!==options.expectedNativeEventId)continue
          // A bounded metadata-only range can locate the Source ordinal for
          // a stable Live native ID, even if other branches shifted ordinals.
          // Duplicate native IDs in this range must not select an arbitrary
          // cursor.
          if (options.expectedNativeEventId!==undefined && items.length>0) {
            return {state:'unsupported',reason:'native-turn-identity-ambiguous'}
          }
          items.push({
            ordinal:item.ordinal,
            ...(item.nativeEventId ? {nativeEventId:item.nativeEventId} : {}),
            cursor:encodeNativeSessionCursor({
              ...item.cursor,mode:'review-turns',turnOrdinal:item.ordinal,
            }),
            ...(item.at?{at:item.at}:{}),
          })
        }
        ordinal=(block+1)*BLOCK_SIZE+1
      }
    }
    return {
      state:'available',
      coverage:state.complete?'complete':'partial',
      knownTurns,
      ...(state.complete?{totalTurns:knownTurns}:{}),
      scannedOffset:state.nextCursor?.offset??0,
      items:items.sort((a,b)=>a.ordinal-b.ordinal),
      hasMore:!state.complete,
    }
  }
}

export async function handleNativeReviewTurnIndexRequest(
  request: IncomingMessage, response: ServerResponse, url: URL,
  service?: NativeReviewTurnIndex,
):Promise<boolean>{
  const match=url.pathname.match(/^\/api\/v1\/native-sessions\/([^/]+)\/turn-index$/)
  if(!match)return false
  if(request.method!=='GET'){
    response.setHeader('allow','GET')
    writeJson(response,405,{error:'method_not_allowed'})
    return true
  }
  if(!service){writeJson(response,503,{state:'unavailable',reason:'native-turn-index-unavailable'});return true}
  if([...url.searchParams.keys()].some(key=>!['ordinal','tail','from','around','limit','scan','expectedNativeEventId'].includes(key))
    || [...url.searchParams.keys()].some(key=>url.searchParams.getAll(key).length!==1)) {
    throw badRequest('Invalid native turn index query')
  }
  const parse=(key:string)=>url.searchParams.has(key)
    ?Number(url.searchParams.get(key)):undefined
  const ordinal=parse('ordinal')
  const tail=parse('tail')
  const from=parse('from')
  const around=parse('around')
  const limit=parse('limit')
  const expectedNativeEventId=url.searchParams.get('expectedNativeEventId')??undefined
  const positions=[ordinal,tail,from,around].filter(value=>value!==undefined)
  if(positions.length>1
    || [ordinal,from,around].some(value=>value!==undefined
      && (!Number.isSafeInteger(value)||value<1||value>MAX_INDEX_ORDINAL))
    || [tail,limit].some(value=>value!==undefined
      && (!Number.isSafeInteger(value)||value<1||value>MAX_INDEX_QUERY))
    || ((ordinal!==undefined||tail!==undefined)&&limit!==undefined)
    || (expectedNativeEventId!==undefined
      && ((ordinal===undefined && from===undefined)
        || expectedNativeEventId.length<1
        || expectedNativeEventId.length>256))
    || (url.searchParams.has('scan') && url.searchParams.get('scan')!=='1')) {
    throw badRequest('Invalid native turn index range')
  }
  let id:string
  try{id=decodeURIComponent(match[1]!)}catch{id=''}
  writeJson(response,200,await service.query(id,{
    ...(ordinal!==undefined?{ordinal}:{}),
    ...(expectedNativeEventId!==undefined?{expectedNativeEventId}:{}),
    ...(tail!==undefined?{tail}:{}),
    ...(from!==undefined?{from}:{}),
    ...(around!==undefined?{around}:{}),
    ...(limit!==undefined?{limit}:{}),
    scan:url.searchParams.has('scan'),
  }))
  return true
}
