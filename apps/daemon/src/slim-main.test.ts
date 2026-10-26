import assert from 'node:assert/strict'
import test from 'node:test'
import { startSlimNativeDaemon } from './slim-main'

test('Slim standalone entry wires only native Reader and HTTP, and disposes on startup failure',async()=>{
  const actions:string[]=[]
  const native={
    nativeSessionCatalog:{async get(){return null},async getByReviewSessionId(){return null},
      async query(){return {items:[],hasMore:false}},
      async isNativeMetricsEligible(){return false}},
    nativeSessionList:{async query(){return {items:[],hasMore:false}}},
    nativeFacets:{async query(){return {
      installedProducts:[],projects:[],projectsTruncated:false}}},
    nativeSessionMetrics:{
      async get(){return {state:'missing'}},
      async replace(){return false},async invalidate(){},
      async overview(){return {eligibleSessions:0}},
      async findRebuildCandidates(){return []},
    },
    async health(){return {ok:true,schemaVersion:1}},
  }
  const runtime={
    async start(){actions.push('start')},
    nativeHttpPort(){actions.push('nativeHttpPort');return native},
    nativeReader(){actions.push('nativeReader');return {
      async read(){return {state:'unsupported',reason:'test'}}}},
    async shutdown(){actions.push('shutdown')},
  }
  const sources={list:()=>[]} as never
  const policy={isSourceEnabled:()=>false} as never
  const running=await startSlimNativeDaemon({
    dbPath:'test-is-injected',
    runtime:runtime as never,sources,capturePolicy:policy,port:0,
  })
  try{
    assert.deepEqual(actions,['start','nativeHttpPort','nativeReader'])
    const base=`http://${running.http.host}:${running.http.port}`
    assert.equal((await fetch(base+'/api/v1/ready')).status,200)
    const old=await fetch(base+'/api/v1/review')
    assert.equal(old.status,501)
  }finally{await running.dispose();await running.dispose()}
  assert.deepEqual(actions,['start','nativeHttpPort','nativeReader','shutdown'])
})
