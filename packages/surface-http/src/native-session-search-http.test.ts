import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  CapturePolicyService, NativeSessionCatalogEntry, NativeSessionCatalogQuery,
  NativeSessionCatalogStore, StorageService,
} from '@agent-lens/core'
import type { NativeSessionWindowReader } from './native-session-http'
import { startHttpSurface } from './server'

const at='2026-10-25T00:00:00Z'
function entry(id:string):NativeSessionCatalogEntry {
  return {
    sourceId:'pi',installationId:'installation',nativeSessionId:id,
    locationKind:'native',filePath:'/private/secret/'+id+'.jsonl',
    fileIdentity:'inode-'+id,fileSize:256,fileMtimeMs:1,
    lastActivityAt:id==='A'?'2026-10-25T10:00:00Z':'2026-10-25T09:00:00Z',
    updatedAt:at,title:'Not matching body text',
  }
}

test('native full-text search pages original Source records and Catalog sessions, never indexing SQL bodies',async()=>{
  const entries=[entry('A'),entry('B')]
  let catalogQueries=0
  const catalog={
    async query(q:NativeSessionCatalogQuery={}){
      catalogQueries++
      assert.equal(q.onlyWithoutLegacyReview,true)
      assert.equal(q.limit,1)
      assert.equal(q.search,undefined,'body search must never pretend Catalog metadata search covers body')
      const offset=q.before?.nativeSessionId==='A'?1:0
      return {items:entries.slice(offset,offset+1),hasMore:offset+1<entries.length}
    },
  } as NativeSessionCatalogStore
  const seen:Array<{session:string;offset:number}>= []
  const reader:NativeSessionWindowReader={
    async read(q){
      const offset=q.cursor?.offset??0
      seen.push({session:q.nativeSessionId,offset})
      assert.equal(q.limit,16)
      assert.equal(q.sourceId,'pi')
      assert.equal(q.installationId,'installation')
      const first=q.nativeSessionId==='A'&&offset===0
      const msg=first?'Agent says Hello Native Search':
        q.nativeSessionId==='A'?'second page has no match':'second session says hello again'
      return {
        state:'available',
        observations:[{
          kind:'message.assistant' as const,
          occurredAt:at,capturedAt:at,payload:{text:msg},
          identityHints:{nativeSessionId:q.nativeSessionId},
        }],
        observationRecordIds:['record-'+q.nativeSessionId+'-'+offset],
        evidenceCandidates:[{
          captureMethod:'native-log' as const,derivation:'reported' as const,
          sourceLocator:{kind:'file' as const,path:'/private/hide-me.jsonl'},
          capturedAt:at,
        }],
        nextCursor:{
          offset:offset+64,sequence:1+(offset/64),
          fileIdentity:'inode-'+q.nativeSessionId,
        },
        hasMore:first,pendingTail:false,
      }
    },
  }
  const policy={isSourceEnabled:(source:string)=>source==='pi'} as CapturePolicyService
  const storage={health:async()=>({ok:true}),nativeSessionCatalog:catalog} as unknown as StorageService
  const app=await startHttpSurface(storage,{port:0,nativeSessionReader:reader,capturePolicy:policy})
  const base=`http://${app.host}:${app.port}/api/v1/native-sessions/search?q=hello`
  try{
    const p1=await (await fetch(base)).json() as {
      state:string;coverage:string;items:Array<{excerpt:string;sessionId:string;observationId:string}>;
      hasMore:boolean;nextCursor:string;scannedSessions:number
    }
    assert.equal(p1.state,'available')
    assert.equal(p1.coverage,'bounded')
    assert.equal(p1.scannedSessions,1)
    assert.equal(p1.items.length,1)
    assert.ok(p1.items[0]?.observationId.startsWith('native-observation:'))
    assert.ok(p1.items[0]?.excerpt.includes('Hello Native'))
    assert.equal(p1.hasMore,true)
    assert.ok(p1.nextCursor)
    const p2=await (await fetch(base+'&cursor='+encodeURIComponent(p1.nextCursor))).json() as typeof p1
    assert.equal(p2.items.length,0,
      'no result from a bounded page is not a claim about the whole corpus')
    assert.equal(p2.hasMore,true)
    const p3=await (await fetch(base+'&cursor='+encodeURIComponent(p2.nextCursor))).json() as typeof p1
    assert.equal(p3.items.length,1)
    assert.equal(p3.hasMore,false)
    assert.equal(p3.nextCursor,undefined)
    assert.deepEqual(seen,[
      {session:'A',offset:0},{session:'A',offset:64},{session:'B',offset:0},
    ])
    assert.equal(catalogQueries,3)
    const serialized=JSON.stringify([p1,p2,p3])
    assert.equal(serialized.includes('/private/'),false)
    assert.equal(serialized.includes('sourceLocator'),false)
    assert.equal(serialized.includes('fileIdentity'),false)
    assert.equal(serialized.includes('hide-me'),false)
    assert.equal((await fetch(base+'&sourceId=codex&cursor='+p1.nextCursor)).status,400,
      'Source-scoped search cursors must not replay in a different search scope')
    assert.equal((await fetch(base.replace('q=hello','q=other')+'&cursor='+p1.nextCursor)).status,400)
    assert.equal((await fetch(base+'&sourceId=')).status,400)
    assert.equal((await fetch(base+'&unknown=x')).status,400)
  }finally{await app.dispose()}
})

test('native body search fails closed on drift and never claims a completed scan',async()=>{
  const catalog={
    async query(){return {items:[entry('A')],hasMore:true}},
  } as unknown as NativeSessionCatalogStore
  const reader:NativeSessionWindowReader={
    async read(){
      return {state:'drifted',reason:'native-file-identity-changed'}
    },
  }
  const storage={health:async()=>({ok:true}),nativeSessionCatalog:catalog} as unknown as StorageService
  const policy={isSourceEnabled:()=>true} as CapturePolicyService
  const app=await startHttpSurface(storage,{port:0,nativeSessionReader:reader,capturePolicy:policy})
  try{
    const url=`http://${app.host}:${app.port}/api/v1/native-sessions/search?q=hello`
    const response=await fetch(url)
    assert.equal(response.status,200)
    assert.deepEqual(await response.json(),{
      state:'drifted',reason:'native-file-identity-changed',
    })
    assert.equal((await fetch(url.replace('q=hello','q=a'))).status,400)
    assert.equal((await fetch(url+'&cursor=malformed')).status,400)
    assert.equal((await fetch(url,{method:'POST'})).status,405)
  }finally{await app.dispose()}
})
