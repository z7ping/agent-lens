import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startSlimNativeDaemon } from './slim-main'

test('Slim standalone entry wires only native Reader and HTTP, and disposes on startup failure',async()=>{
  const actions:string[]=[]
  const webRoot=await mkdtemp(join(tmpdir(),'al-slim-web-'))
  await writeFile(join(webRoot,'index.html'),'<html><body>existing-task-surface</body></html>')
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
    async facets(){return {installedProducts:[],projects:[],projectsTruncated:false}},
    nativeReader(){actions.push('nativeReader');return {
      async read(){return {state:'unsupported',reason:'test'}}}},
    async shutdown(){actions.push('shutdown')},
  }
  const sources={list:()=>[]} as never
  const policy={isSourceEnabled:()=>false} as never
  const running=await startSlimNativeDaemon({
    dbPath:'test-is-injected',
    runtime:runtime as never,sources,capturePolicy:policy,port:0,webRoot,
    backup:{
      async overview(){return {
        vaultPath:'/unit-vault',sources:[],snapshots:[],
      }},
    } as never,
  })
  try{
    assert.deepEqual(actions,['start','nativeHttpPort','nativeReader'])
    const base=`http://${running.http.host}:${running.http.port}`
    assert.equal((await fetch(base+'/api/v1/ready')).status,200)
    const page=await fetch(base+'/review/native:0123456789abcdef0123456789abcdef')
    assert.equal(page.status,200,'existing SPA route must be served from Slim')
    assert.match(await page.text(),/existing-task-surface/)
    const rootPage=await fetch(base+'/')
    assert.equal(rootPage.status,200)
    assert.match(await rootPage.text(),/existing-task-surface/)
    const backup=await fetch(base+'/api/v1/backups')
    assert.equal(backup.status,200)
    assert.equal((await backup.json() as {vaultPath:string}).vaultPath,'/unit-vault')
    const old=await fetch(base+'/api/v1/review')
    assert.equal(old.status,501)
  }finally{
    await running.dispose();await running.dispose()
    await rm(webRoot,{recursive:true,force:true})
  }
  assert.deepEqual(actions,['start','nativeHttpPort','nativeReader','shutdown'])
})
