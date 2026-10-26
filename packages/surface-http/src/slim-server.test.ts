import assert from 'node:assert/strict'
import test from 'node:test'
import type { CapturePolicyService, SourceService } from '@agent-lens/core'
import { startNativeOnlyHttpSurface } from './slim-server'

test('Slim-only HTTP reads native Catalog/facets and refuses all old Event APIs',async()=>{
  let listed=0
  const source={
    manifest:{sourceId:'pi',productId:'pi',parserVersion:'v1',displayName:'Pi'},
    nativeSessionCoverageComplete:true,
  }
  const sources={list:()=>[source]} as unknown as SourceService
  const policy={isSourceEnabled:()=>true} as unknown as CapturePolicyService
  const storage={
    nativeSessionCatalog:{
      async getByReviewSessionId(){return null},
      async get(){return null},
      async query(){throw new Error('Slim handler should prefer session list')},
      async isNativeMetricsEligible(){return true},
    },
    nativeSessionList:{async query(input:{limit:number}){
      listed++
      assert.equal(input.limit,5)
      return {items:[],hasMore:false}
    }},
    nativeFacets:{async query(){
      return {installedProducts:[{productId:'pi',installationIds:['install']}],
        projects:[],projectsTruncated:false}
    }},
    nativeSessionMetrics:{
      async get(){return {state:'missing' as const}},
      async replace(){return true},
      async invalidate(){},
      async overview(){return {
        sourceId:'pi',eligibleSessions:0,readySessions:0,missingSessions:0,
        staleSessions:0,partialSessions:0,
        totals:{interactionCount:0,toolCallCount:0,toolResultCount:0,
          toolErrorCount:0,errorCount:0,inputTokens:null,outputTokens:null},
        tools:[],toolsTruncated:false,
      }},
      async findRebuildCandidates(){return []},
    },
    async health(){return {ok:true,schemaVersion:1,
      details:{schemaKind:'slim-native-session-v1'}}},
  }
  const reader={async read(){return {state:'unsupported',reason:'not-indexed'}}}
  const surface=await startNativeOnlyHttpSurface(storage as never,{
    port:0,sources,reader:reader as never,capturePolicy:policy,
  })
  const base=`http://${surface.host}:${surface.port}`
  try{
    const ready=await fetch(base+'/api/v1/ready')
    assert.equal(ready.status,200)
    assert.equal((await ready.json() as {storageMode:string}).storageMode,'native-only')
    const list=await fetch(base+'/api/v1/native-sessions?sourceId=pi&limit=5')
    assert.equal(list.status,200)
    assert.deepEqual((await list.json() as {items:unknown[]}).items,[])
    assert.equal(listed,1)
    const facets=await fetch(base+'/api/v1/facets')
    assert.equal(facets.status,200)
    assert.equal((await facets.json() as {agents:Array<{sourceId:string}>}).agents[0]?.sourceId,'pi')
    const health=await fetch(base+'/api/v1/health')
    assert.equal(health.status,200)
    assert.equal((await health.json() as {storage:{schemaVersion:number}}).storage.schemaVersion,1)
    for(const name of ['source-records','timeline','review','sessions','assets']){
      const old=await fetch(base+'/api/v1/'+name)
      assert.equal(old.status,501,name)
      assert.equal((await old.json() as {error:string}).error,
        'native_only_route_not_implemented')
    }
  }finally{await surface.dispose()}
})
