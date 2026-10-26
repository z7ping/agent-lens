import assert from 'node:assert/strict'
import test from 'node:test'
import type { CapturePolicyService, SourceService, StorageService } from '@agent-lens/core'
import { startHttpSurface } from './server'

test('native overview consults only bounded numerical cache, filters authorization and reports partial coverage',async()=>{
  const captured:Array<{sourceId:string;parserVersion:string;coverageCertified:boolean}>= []
  const storage={
    health:async()=>({ok:true}),
    nativeSessionMetrics:{
      async overview(query:{sourceId:string;parserVersion:string;coverageCertified:boolean}){
        captured.push(query)
        return {
          sourceId:query.sourceId,eligibleSessions:3,readySessions:1,
          missingSessions:1,staleSessions:1,partialSessions:0,
          totals:{
            interactionCount:2,toolCallCount:1,toolResultCount:1,
            toolErrorCount:0,errorCount:0,inputTokens:null,outputTokens:20,
          },
          tools:[],toolsTruncated:false,
        }
      },
    },
  } as unknown as StorageService
  const sources={list:()=>[
    {manifest:{sourceId:'pi',parserVersion:'pi-v9'},nativeSessionCoverageComplete:true},
    {manifest:{sourceId:'codex',parserVersion:'codex-v2'}},
  ]} as unknown as SourceService
  const policy={isSourceEnabled:(id:string)=>id==='pi'} as unknown as CapturePolicyService
  const app=await startHttpSurface(storage,{port:0,sources,capturePolicy:policy})
  const base=`http://${app.host}:${app.port}/api/v1/native-sessions/metrics/overview`
  try{
    const result=await (await fetch(base)).json() as {
      state:string;coverage:string;
      items:Array<{sourceId:string;totals:{inputTokens:number|null}}>;
      totals:{eligibleSessions:number;readySessions:number;missingSessions:number}
    }
    assert.equal(result.state,'available')
    assert.equal(result.coverage,'partial')
    assert.deepEqual(result.items.map(x=>x.sourceId),['pi'])
    assert.equal(result.items[0]?.totals.inputTokens,null)
    assert.deepEqual(result.totals,{eligibleSessions:3,readySessions:1,
      missingSessions:1,staleSessions:1,partialSessions:0})
    assert.deepEqual(captured,[{sourceId:'pi',parserVersion:'pi-v9',coverageCertified:true}])
    assert.equal(JSON.stringify(result).includes('filePath'),false)
    assert.equal((await fetch(base+'?sourceId=codex')).status,200)
    assert.deepEqual(await (await fetch(base+'?projectId=secret')).json(),{
      state:'unsupported',reason:'native-project-metrics-require-slim',
    })
    assert.equal((await fetch(base+'?sourceId=pi&sourceId=codex')).status,400)
    assert.equal((await fetch(base,{method:'POST'})).status,405)
  }finally{await app.dispose()}
})

test('Slim-only numerical overview passes project and installation scope without Canonical rows',async()=>{
  const captured:Array<Record<string,unknown>>=[]
  const storage={
    health:async()=>({ok:true}),
    nativeSessionList:{async query(){return {items:[],hasMore:false}}},
    nativeSessionMetrics:{
      async overview(query:Record<string,unknown>){
        captured.push(query)
        return {
          sourceId:query.sourceId,eligibleSessions:1,readySessions:0,
          missingSessions:1,staleSessions:0,partialSessions:0,
          totals:{interactionCount:0,toolCallCount:0,toolResultCount:0,
            toolErrorCount:0,errorCount:0,inputTokens:null,outputTokens:null},
          tools:[],toolsTruncated:false,
        }
      },
    },
  } as unknown as StorageService
  const sources={list:()=>[
    {manifest:{sourceId:'pi',parserVersion:'pi-v9'},nativeSessionCoverageComplete:false},
  ]} as unknown as SourceService
  const policy={isSourceEnabled:()=>true} as unknown as CapturePolicyService
  const app=await startHttpSurface(storage,{port:0,sources,capturePolicy:policy})
  try{
    const url=`http://${app.host}:${app.port}/api/v1/native-sessions/metrics/overview?projectId=p1&installationId=i1`
    const response=await fetch(url)
    assert.equal(response.status,200)
    const body=await response.json() as {state:string;coverage:string}
    assert.equal(body.state,'available')
    assert.equal(body.coverage,'partial')
    assert.equal(captured[0]?.projectId,'p1')
    assert.equal(captured[0]?.installationId,'i1')
    assert.equal(captured[0]?.coverageCertified,false)
  }finally{await app.dispose()}
})
