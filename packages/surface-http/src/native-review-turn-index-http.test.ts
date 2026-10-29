import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  CapturePolicyService, NativeSessionCatalogEntry, SourceService,
  SourceNativeSessionCursor, ObservationCandidate,
} from '@agent-lens/core'
import { NativeReviewTurnIndex, type NativeTurnIndexCheckpointStore } from './native-review-turn-index-http'
import type { NativeSessionWindowReader } from './native-session-http'

test('native sparse turn index is bounded, restart-resumable and invalidates replacements',async()=>{
  const at='2026-10-29T01:00:00.000Z'
  let fileIdentity='test:inode-1'
  let fileSize=260
  let mtime=1
  let records=Array.from({length:260},(_,n)=>({
    kind:n%17===0?'message.user':'message.commentary',
    occurredAt:at,capturedAt:at,payload:{text:'payload-'+n},
  } as ObservationCandidate))
  const id='native:'+'a'.repeat(32)
  const checkpoint=new Map<string,unknown>()
  const store:NativeTurnIndexCheckpointStore={
    async get<T>(scope,key){return checkpoint.get(scope+'|'+key) as T??null},
    async set(scope,key,value){checkpoint.set(scope+'|'+key,value)},
  }
  const entry=():NativeSessionCatalogEntry=>({
    sourceId:'pi',installationId:'inst',nativeSessionId:'s',locationKind:'native',
    filePath:'/sample.jsonl',fileIdentity,fileSize,fileMtimeMs:mtime,
    lastActivityAt:at,updatedAt:at,
  })
  const catalog={async getByReviewSessionId(key:string){return key===id?entry():null}}
  const sources={list(){return [{
    manifest:{sourceId:'pi',parserVersion:'v1'},readNativeSessionPage:()=>undefined,
  }]}} as unknown as SourceService
  const policy={isSourceEnabled(sourceId:string){return sourceId==='pi'}} as CapturePolicyService
  let reads=0
  const reader:NativeSessionWindowReader={
    async read(query){
      reads++
      const start=query.cursor?.offset??0
      if(query.cursor?.fileIdentity!==undefined && query.cursor.fileIdentity!==fileIdentity)
        return {state:'drifted',reason:'native-file-identity-changed'}
      const end=Math.min(records.length,start+(query.limit??16))
      const cursor=(index:number):SourceNativeSessionCursor=>({
        offset:index,sequence:index,fileIdentity,
      })
      return {
        state:'available',observations:records.slice(start,end),
        observationRecordIds:records.slice(start,end).map((_,i)=>'rec-'+(i+start)),
        observationCursors:records.slice(start,end).map((_,i)=>cursor(i+start)),
        evidenceCandidates:[],nextCursor:cursor(end),
        hasMore:end<records.length,pendingTail:false,
      }
    },
  }
  const index=()=>new NativeReviewTurnIndex(reader,catalog,store,sources,policy)
  const first=await index().query(id,{scan:true,tail:3})
  assert.equal(first.state,'available')
  if(first.state!=='available')return
  assert.equal(first.coverage,'partial')
  assert.equal(first.knownTurns,12)
  assert.equal(first.totalTurns,undefined,'partial scans must never pretend to know total')
  const second=await index().query(id,{scan:true,tail:3})
  assert.equal(second.state,'available')
  if(second.state!=='available')return
  assert.equal(second.coverage,'complete')
  assert.equal(second.totalTurns,16)
  assert.deepEqual(second.items.map(x=>x.ordinal),[14,15,16])
  const decoded=JSON.parse(Buffer.from(second.items[0]!.cursor,'base64url').toString('utf8'))
  assert.deepEqual([decoded.offset,decoded.turnOrdinal,decoded.mode],[221,14,'review-turns'])
  const range=await index().query(id,{from:5,limit:4})
  assert.equal(range.state,'available')
  if(range.state==='available')assert.deepEqual(range.items.map(x=>x.ordinal),[5,6,7,8])
  const around=await index().query(id,{around:10,limit:5})
  assert.equal(around.state,'available')
  if(around.state==='available')assert.deepEqual(around.items.map(x=>x.ordinal),[8,9,10,11,12])
  const readsAfter=reads
  const reopened=await index().query(id,{ordinal:10})
  assert.equal(reads,readsAfter,'persisted boundaries must not rehydrate source bodies')
  assert.equal(reopened.state,'available')
  if(reopened.state==='available')assert.deepEqual(reopened.items.map(x=>x.ordinal),[10])
  // Append-only growth resumes from the verified last cursor.
  records.push({kind:'message.user',occurredAt:at,capturedAt:at,payload:{text:'new'}} as ObservationCandidate)
  fileSize=records.length
  mtime++
  const changed=await index().query(id,{tail:1})
  assert.equal(changed.state,'available')
  if(changed.state==='available'){
    assert.equal(changed.coverage,'partial')
    assert.equal(changed.totalTurns,undefined,'append must revoke stale complete coverage')
  }
  const appended=await index().query(id,{scan:true,tail:1})
  assert.equal(appended.state,'available')
  if(appended.state==='available'){
    assert.equal(appended.totalTurns,17)
    assert.equal(appended.items[0]?.ordinal,17)
  }
  // A new source inode makes all old per-turn offsets unavailable immediately.
  fileIdentity='test:inode-2';mtime++
  const invalidated=await index().query(id,{ordinal:17})
  assert.equal(invalidated.state,'available')
  if(invalidated.state==='available'){
    assert.equal(invalidated.coverage,'partial')
    assert.equal(invalidated.knownTurns,0)
    assert.deepEqual(invalidated.items,[])
  }
  assert.equal([...checkpoint.values()].some(value=>JSON.stringify(value).includes('payload-')),false,
    'only source cursor and lightweight metadata may be persisted')
})
