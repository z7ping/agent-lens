import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  CapturePolicyService, NativeSessionCatalogEntry, NativeSessionMetricsStore,
  NativeSessionMetricSnapshot, SourceService, StorageService,
} from '@agent-lens/core'
import { nativeReviewSessionId } from '@agent-lens/projection-review'
import type { NativeSessionWindowReader } from './native-session-http'
import { startHttpSurface } from './server'

const at='2026-10-25T00:00:00Z'
const entry:NativeSessionCatalogEntry={
  sourceId:'pi',installationId:'pi-local',nativeSessionId:'native-1',
  locationKind:'native',filePath:'/private/native.jsonl',
  fileIdentity:'inode-2',fileSize:256,fileMtimeMs:22,
  lastActivityAt:at,updatedAt:at,title:'Test session',
}
const id=nativeReviewSessionId(entry.sourceId,entry.installationId,entry.nativeSessionId)
const policy={isSourceEnabled:()=>true} as unknown as CapturePolicyService
const sources={
  list:()=>[{manifest:{sourceId:'pi',productId:'pi',parserVersion:'pi-version-3'},
    readNativeSessionPage(){throw Error('Reader Worker must read source, never HTTP directly')}}],
} as unknown as SourceService
const unsupportedStorage={health:async()=>({ok:true})} as unknown as StorageService

test('explicit native metric rebuild consumes Source reader pages, persists numbers only',async()=>{
  let cached:NativeSessionMetricSnapshot|null=null
  let catalogRevision=entry.fileSize
  const stored:NativeSessionMetricsStore={
    async replace(snapshot){
      if(snapshot.fileSize!==catalogRevision)return false
      cached=snapshot;return true
    },
    async get(){return cached?{state:'available',snapshot:cached}:{state:'missing'}},
    async invalidate(){cached=null},
  }
  const catalog={
    getByReviewSessionId:async(q:string)=>q===id?entry:null,
    hasNativeOnlyWriteClaim:async()=>true,
  }
  const seenOffsets:number[]=[]
  const reader:NativeSessionWindowReader={
    async read(query){
      seenOffsets.push(query.cursor?.offset??0)
      if(!query.cursor){
        return {
          state:'available',
          observations:[
            {kind:'message.user' as const,payload:{text:'secret prompt'},
              identityHints:{nativeSessionId:'native-1'},capturedAt:at},
            {kind:'tool.call' as const,payload:{callId:'t-1',nativeToolName:'shell',input:{password:'secret'}},
              identityHints:{nativeSessionId:'native-1'},capturedAt:at},
          ],
          observationRecordIds:['native-user','native-call'],
          evidenceCandidates:[],
          nextCursor:{offset:32,sequence:2,fileIdentity:'inode-2'},
          hasMore:true,pendingTail:false,
        }
      }
      return {
        state:'available',
        observations:[
          {kind:'tool.result' as const,payload:{callId:'t-1',success:false,durationMs:10,output:'private'},
            identityHints:{nativeSessionId:'native-1'},capturedAt:at},
          {kind:'usage' as const,payload:{inputTokens:100,outputTokens:20},
            identityHints:{nativeSessionId:'native-1'},capturedAt:at},
        ],
        observationRecordIds:['native-result','native-usage'],
        evidenceCandidates:[],
        nextCursor:{offset:64,sequence:4,fileIdentity:'inode-2'},
        hasMore:false,pendingTail:false,
      }
    },
  }
  const storage={
    ...unsupportedStorage,nativeSessionCatalog:catalog,
    nativeSessionMetrics:stored,
  } as unknown as StorageService
  const app=await startHttpSurface(storage,{port:0,nativeSessionReader:reader,sources,capturePolicy:policy})
  try{
    const base=`http://${app.host}:${app.port}/api/v1/native-sessions/${encodeURIComponent(id)}/metrics`
    assert.deepEqual(await (await fetch(base)).json(),{state:'missing'})
    const response=await fetch(base+'/rebuild',{method:'POST'})
    assert.equal(response.status,200)
    const body=await response.json() as {state:string;coverage:string;snapshot:NativeSessionMetricSnapshot}
    assert.equal(body.state,'available')
    assert.equal(body.coverage,'complete')
    assert.deepEqual(seenOffsets,[0,32])
    assert.equal(body.snapshot.toolCallCount,1)
    assert.equal(body.snapshot.toolResultCount,1)
    assert.equal(body.snapshot.toolErrorCount,1)
    assert.equal(body.snapshot.interactionCount,1)
    assert.equal(body.snapshot.inputTokens,100)
    assert.equal(body.snapshot.outputTokens,20)
    assert.deepEqual(body.snapshot.tools,[
      {nativeToolName:'shell',callCount:1,resultCount:1,errorCount:1,totalDurationMs:10},
    ])
    assert.equal(body.snapshot.parserVersion,'pi-version-3')
    assert.equal(JSON.stringify(body).includes('password'),false)
    assert.equal(JSON.stringify(body).includes('/private'),false)
    assert.equal(JSON.stringify(body).includes('native-user'),false)
    assert.equal((await (await fetch(base)).json() as {state:string}).state,'available')
    catalogRevision=999
    const rejected=await (await fetch(base+'/rebuild',{method:'POST'})).json()
    assert.deepEqual(rejected,{state:'drifted',reason:'native-metrics-catalog-revision-changed'})
    assert.equal((await fetch(base+'/rebuild')).status,405)
    assert.equal((await fetch(base+'?force=1')).status,400)
  }finally{await app.dispose()}
})

test('native metric materialization never marks unverified Hook coverage complete',async()=>{
  const hookEntry={...entry,sourceId:'claude-code'}
  const hookId=nativeReviewSessionId(hookEntry.sourceId,hookEntry.installationId,hookEntry.nativeSessionId)
  let recorded:NativeSessionMetricSnapshot|null=null
  const storage={
    ...unsupportedStorage,
    nativeSessionCatalog:{
      getByReviewSessionId:async()=>hookEntry,
      hasNativeOnlyWriteClaim:async()=>true,
    },
    nativeSessionMetrics:{
      get:async()=>({state:'missing'}),
      replace:async(s:NativeSessionMetricSnapshot)=>{recorded=s;return true},
    },
  } as unknown as StorageService
  const reader:NativeSessionWindowReader={
    async read(){return {
      state:'available',observations:[],observationRecordIds:[],evidenceCandidates:[],
      nextCursor:{offset:0,sequence:0,fileIdentity:hookEntry.fileIdentity},
      hasMore:false,pendingTail:false,
    }},
  }
  const sourceService={
    list:()=>[{manifest:{sourceId:'claude-code',parserVersion:'claude-v3'},
      readNativeSessionPage:async()=>{throw Error('must not call')}}],
  } as unknown as SourceService
  const app=await startHttpSurface(storage,{port:0,nativeSessionReader:reader,
    sources:sourceService,capturePolicy:policy})
  try{
    const url=`http://${app.host}:${app.port}/api/v1/native-sessions/${encodeURIComponent(hookId)}/metrics/rebuild`
    const body=await (await fetch(url,{method:'POST'})).json() as {
      state:string;coverage:string;reason:string
    }
    assert.equal(body.state,'available')
    assert.equal(body.coverage,'partial')
    assert.equal(body.reason,'native-source-coverage-unverified')
    assert.equal((recorded as NativeSessionMetricSnapshot | null)?.coverage,'partial')
  }finally{await app.dispose()}
})
