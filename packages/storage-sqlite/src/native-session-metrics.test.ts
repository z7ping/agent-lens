import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import type { NativeSessionMetricSnapshot } from '@agent-lens/core'
import { SqliteSlimStorage } from './slim-storage'

async function createFixture() {
  const storage=await SqliteSlimStorage.createFresh(':memory:')
  storage.db.exec(`
    INSERT INTO hosts(id,name,platform,arch,created_at,last_seen_at)
      VALUES ('test-host','test','linux','x64','2026-10-25','2026-10-25');
    INSERT INTO agent_products(id,name) VALUES ('pi','Pi');
    INSERT INTO agent_installations(id,host_id,product_id,first_seen_at,last_seen_at)
      VALUES ('pi-local','test-host','pi','2026-10-25','2026-10-25');
  `)
  return storage
}

const at='2026-10-25T00:00:00.000Z'
const identity={sourceId:'pi',installationId:'pi-local',nativeSessionId:'session-1'}
const location={
  ...identity,locationKind:'native' as const,filePath:resolve('native/session-1.jsonl'),
  fileIdentity:'device:inode',fileSize:1000,fileMtimeMs:200,
  lastActivityAt:at,updatedAt:at,
}
const snapshot=():NativeSessionMetricSnapshot=>({
  ...identity,
  fileIdentity:location.fileIdentity,fileSize:location.fileSize,
  fileMtimeMs:location.fileMtimeMs,
  parserVersion:'pi-v1',projectionVersion:'native-stats-v1',
  coverage:'complete',interactionCount:12,
  toolCallCount:5,toolResultCount:4,toolErrorCount:1,errorCount:2,
  inputTokens:null,outputTokens:200,computedAt:at,
  tools:[
    {nativeToolName:'read',callCount:3,resultCount:3,errorCount:0,totalDurationMs:12,durationSampleCount:3,maxDurationMs:8},
    {nativeToolName:'shell',callCount:2,resultCount:1,errorCount:1,totalDurationMs:300,durationSampleCount:1,maxDurationMs:300},
  ],
})

test('native metrics persist only bounded numerical rollups, never event contents',async()=>{
  const storage=await createFixture()
  try{
    const metrics=storage.nativeSessionMetrics
    assert.deepEqual(await metrics.get(identity),{state:'missing'})
    assert.equal(await metrics.replace(snapshot()),false,
      'a missing Native Catalog is not proof of a source revision')
    await storage.nativeSessionCatalog.upsert(location)
    assert.equal(await metrics.replace(snapshot()),true)
    const result=await metrics.get(identity)
    assert.equal(result.state,'available')
    if(result.state!=='available')return
    assert.deepEqual(result.snapshot,{
      ...snapshot(),tools:[...snapshot().tools].sort((a,b)=>a.nativeToolName.localeCompare(b.nativeToolName)),
    })
    assert.equal(result.snapshot.inputTokens,null,'unknown usage must not become zero')
    assert.equal(result.snapshot.tools.find(tool=>tool.nativeToolName==='shell')?.durationSampleCount,1)
    assert.equal(result.snapshot.tools.find(tool=>tool.nativeToolName==='shell')?.maxDurationMs,300)
    await assert.rejects(metrics.replace({...snapshot(),tools:[{
      nativeToolName:'invalid',callCount:1,resultCount:1,errorCount:0,
      totalDurationMs:0,durationSampleCount:0,maxDurationMs:10,
    }]}),/Invalid native tool duration samples/)
    const tableRows=storage.db.prepare(`
      SELECT name,sql FROM sqlite_master
      WHERE name IN ('native_session_metrics','native_session_tool_metrics')
      ORDER BY name
    `).all() as Array<{name:string,sql:string}>
    assert.equal(tableRows.length,2)
    const schema=tableRows.map(row=>row.sql.toLowerCase()).join('\n')
    for(const token of ['payload_json','source_record_id','observation_id','evidence','error_message','tool_input','tool_output','message_text']){
      assert.equal(schema.includes(token),false,`projection must not persist ${token}`)
    }
    const all=storage.db.prepare('SELECT * FROM native_session_metrics').all()
    assert.equal(JSON.stringify(all).includes('prompt'),false)
    assert.equal(JSON.stringify(all).includes('content'),false)
    assert.equal((storage.db.prepare('SELECT COUNT(*) as n FROM native_session_tool_metrics')
      .get() as {n:number}).n,2)
    const shorter={...snapshot(),coverage:'partial' as const,inputTokens:0,
      tools:[{nativeToolName:'shell',callCount:1,resultCount:0,errorCount:0,totalDurationMs:0,durationSampleCount:0,maxDurationMs:null}]}
    assert.equal(await metrics.replace(shorter),true)
    const updated=await metrics.get(identity)
    assert.equal(updated.state,'available')
    if(updated.state==='available'){
      assert.deepEqual(updated.snapshot.tools,shorter.tools)
      assert.equal(updated.snapshot.coverage,'partial')
    }
    assert.equal((storage.db.prepare('SELECT COUNT(*) as n FROM native_session_tool_metrics')
      .get() as {n:number}).n,1)
  }finally{await storage.close()}
})

test('native metric revisions become stale on source changes and reject invalid replacement',async()=>{
  const storage=await createFixture()
  try{
    const metrics=storage.nativeSessionMetrics
    await storage.nativeSessionCatalog.upsert(location)
    assert.equal(await metrics.replace(snapshot()),true)
    await storage.nativeSessionCatalog.upsert({
      ...location,fileSize:1050,fileMtimeMs:205,
    })
    assert.deepEqual(await metrics.get(identity),{state:'stale'})
    assert.equal(await metrics.replace(snapshot()),false,
      'outdated projection must not overwrite a new native source revision')
    const next={...snapshot(),fileSize:1050,fileMtimeMs:205,
      parserVersion:'pi-v2',projectionVersion:'stats-v2',outputTokens:null}
    assert.equal(await metrics.replace(next),true)
    assert.equal((await metrics.get(identity)).state,'available')
    await assert.rejects(metrics.replace({...next,toolCallCount:-1}),/Invalid native metric/)
    await assert.rejects(metrics.replace({...next,tools:[
      {nativeToolName:'read',callCount:1,resultCount:1,errorCount:0,totalDurationMs:0},
      {nativeToolName:'read',callCount:1,resultCount:1,errorCount:0,totalDurationMs:0},
    ]}),/duplicate native tool name/)
    assert.equal((await metrics.get(identity)).state,'available')
    await metrics.invalidate(identity)
    assert.deepEqual(await metrics.get(identity),{state:'missing'})
    assert.equal((storage.db.prepare('SELECT count(*) n FROM native_session_tool_metrics')
      .get() as {n:number}).n,0,'explicit invalidation cascades to tool totals')
  }finally{await storage.close()}
})

test('native metric replacement is atomic if tool inserts fail',async()=>{
  const storage=await createFixture()
  try{
    await storage.nativeSessionCatalog.upsert(location)
    const metrics=storage.nativeSessionMetrics
    assert.equal(await metrics.replace(snapshot()),true)
    storage.db.exec(`
      CREATE TRIGGER reject_native_tool_write
      BEFORE INSERT ON native_session_tool_metrics
      WHEN NEW.native_tool_name = 'fail'
      BEGIN SELECT RAISE(ABORT, 'native-metric-test-rollback'); END;
    `)
    await assert.rejects(metrics.replace({
      ...snapshot(),interactionCount:99,
      tools:[{nativeToolName:'fail',callCount:1,resultCount:0,errorCount:0,totalDurationMs:0}],
    }),/native-metric-test-rollback/)
    const old=await metrics.get(identity)
    assert.equal(old.state,'available')
    if(old.state==='available'){
      assert.equal(old.snapshot.interactionCount,12)
      assert.equal(old.snapshot.tools.length,2)
    }
  }finally{await storage.close()}
})
