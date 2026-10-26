import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  CapturePolicyService, SourceService, StorageService,
} from '@agent-lens/core'
import { startHttpSurface } from './server'

test('native-only Usage/Insights HTTP returns Source-verified metrics without Legacy query',async()=>{
  const scopes:Array<Record<string,unknown>>=[]
  const storage={
    health:async()=>({ok:true}),
    nativeSessionList:{async query(){return {items:[],hasMore:false}}},
    nativeSessionMetrics:{
      async overview(query:Record<string,unknown>){
        scopes.push(query)
        return {
          sourceId:'pi',eligibleSessions:3,readySessions:2,
          missingSessions:1,staleSessions:0,partialSessions:0,
          totals:{interactionCount:7,toolCallCount:4,toolResultCount:4,
            toolErrorCount:1,errorCount:1,inputTokens:100,outputTokens:50},
          tools:[{nativeToolName:'shell',callCount:4,resultCount:4,
            errorCount:1,sessionCount:2,totalDurationMs:100}],
          toolsTruncated:false,
        }
      },
    },
    // Deliberately no repositories or Legacy SessionSummary. A hidden Legacy
    // query would throw here and fail this HTTP-level test.
  } as unknown as StorageService
  const sources={list(){return [{
    manifest:{sourceId:'pi',productId:'pi',parserVersion:'v1',displayName:'Pi'},
    nativeSessionCoverageComplete:true,
  }]}} as unknown as SourceService
  const policy={isSourceEnabled:()=>true} as unknown as CapturePolicyService
  const server=await startHttpSurface(storage,{port:0,sources,capturePolicy:policy})
  try{
    const base=`http://${server.host}:${server.port}/api/v1`
    const usage=await fetch(base+'/usage?sourceId=pi&projectId=project-1')
    assert.equal(usage.status,200)
    const u=await usage.json() as {
      tools:unknown[];meta:{mode:string;native:{state:string;readySessions:number;tools:any[]}}
    }
    assert.equal(u.meta.mode,'native-only')
    assert.equal(u.tools.length,0)
    assert.equal(u.meta.native.state,'available')
    assert.equal(u.meta.native.readySessions,2)
    assert.equal(u.meta.native.tools[0]?.callCount,4)
    const insights=await fetch(base+'/insights?sourceId=pi&projectId=project-1')
    assert.equal(insights.status,200)
    const i=await insights.json() as {
      summary:{sessionCount:number}
      meta:{mode:string;native:{state:string;toolCallCount:number;coverage:string}}
    }
    assert.equal(i.meta.mode,'native-only')
    assert.equal(i.meta.native.toolCallCount,4)
    assert.equal(i.meta.native.coverage,'partial')
    assert.equal(scopes.length,2)
    assert.equal(scopes.every(query=>query.projectId==='project-1'),true)
    const drill=await fetch(base+'/usage/detail')
    assert.equal(drill.status,501)
    assert.equal(JSON.stringify(i).includes('private-source-file'),false)
  }finally{await server.dispose()}
})
