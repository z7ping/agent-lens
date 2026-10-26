import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import {
  NATIVE_SESSION_METRIC_PROJECTION_VERSION,
  type NativeSessionMetricSnapshot,
} from '@agent-lens/core'
import {SqliteStorageService} from './storage'
import { SqliteSlimStorage } from './slim-storage'

const at='2026-10-25T00:00:00Z'
const source='pi',installation='pi-local',parserVersion='pi-v2'
function location(nativeSessionId:string, fileSize=120){
  return {
    sourceId:source,installationId:installation,nativeSessionId,
    locationKind:'native' as const,
    filePath:resolve('fixtures/native-'+nativeSessionId+'.jsonl'),
    fileIdentity:'dev:inode-'+nativeSessionId,fileSize,
    fileMtimeMs:100,lastActivityAt:at,updatedAt:at,
  }
}
function metric(nativeSessionId:string,coverage:'complete'|'partial'='complete'):NativeSessionMetricSnapshot{
  const row=location(nativeSessionId)
  return{
    sourceId:row.sourceId,installationId:row.installationId,
    nativeSessionId,fileIdentity:row.fileIdentity,fileSize:row.fileSize,
    fileMtimeMs:row.fileMtimeMs,parserVersion,
    projectionVersion:NATIVE_SESSION_METRIC_PROJECTION_VERSION,
    computedAt:at,coverage,interactionCount:5,toolCallCount:3,
    toolResultCount:2,toolErrorCount:1,errorCount:1,
    inputTokens:null,outputTokens:10,
    tools:[{nativeToolName:'shell',callCount:3,resultCount:2,
      errorCount:1,totalDurationMs:200}],
  }
}

test('native metrics overview counts only complete, current Native-only owned sessions',async()=>{
  const storage=new SqliteStorageService({path:':memory:'})
  await storage.migrate()
  try{
    for(const id of ['ready','partial','missing','stale','legacy']){
      const locationRow=location(id)
      await storage.nativeSessionCatalog.upsert(locationRow)
      if(id==='legacy'){
        assert.equal(await storage.nativeSessionCatalog.claimLegacyWrite(locationRow),'legacy')
      }else{
        assert.equal(await storage.nativeSessionCatalog.claimNativeOnlyWrite(locationRow),true)
      }
    }
    const metrics=storage.nativeSessionMetrics
    assert.equal(await metrics.replace(metric('ready')),true)
    assert.equal(await metrics.replace(metric('partial','partial')),true)
    assert.equal(await metrics.replace(metric('stale')),true)
    assert.equal(await metrics.replace(metric('legacy')),true)
    await storage.nativeSessionCatalog.upsert(location('stale',121))
    // Only durable Native-only missing/stale revisions are selected.
    const pending=await metrics.findRebuildCandidates({
      sourceId:source,parserVersion,
    },4)
    assert.deepEqual(pending.map(row=>row.nativeSessionId).sort(),['missing','stale'])
    assert.ok(pending.every(row=>/^native:[a-f0-9]{32}$/.test(row.reviewSessionId)))
    assert.deepEqual(await metrics.findRebuildCandidates({
      sourceId:'unregistered',parserVersion,
    },4),[])
    await assert.rejects(()=>metrics.findRebuildCandidates({
      sourceId:source,parserVersion,
    },100),/Invalid native metric refresh scope/)

    const overview=await metrics.overview({sourceId:source,parserVersion,coverageCertified:true})
    assert.equal(overview.eligibleSessions,4)
    assert.deepEqual([
      overview.readySessions,overview.partialSessions,overview.missingSessions,overview.staleSessions,
    ],[1,1,1,1])
    assert.deepEqual(overview.totals,{
      interactionCount:5,toolCallCount:3,toolResultCount:2,toolErrorCount:1,
      errorCount:1,inputTokens:null,outputTokens:10,
    })
    assert.deepEqual(overview.tools,[{
      nativeToolName:'shell',callCount:3,resultCount:2,errorCount:1,
      totalDurationMs:200,sessionCount:1,
    }])
    assert.equal(overview.toolsTruncated,false)
    const shellDetail=await metrics.overview({sourceId:source,parserVersion,
      coverageCertified:true,nativeToolName:'shell'})
    assert.deepEqual(shellDetail.tools,overview.tools)
    assert.equal(shellDetail.eligibleSessions,overview.eligibleSessions)
    const absentDetail=await metrics.overview({sourceId:source,parserVersion,
      coverageCertified:true,nativeToolName:'does-not-exist'})
    assert.deepEqual(absentDetail.tools,[])
    assert.equal(absentDetail.toolsTruncated,false)
    await assert.rejects(()=>metrics.overview({sourceId:source,parserVersion,
      nativeToolName:'  '}),/Invalid Native-only metrics aggregate query/)
    assert.equal((await metrics.overview({sourceId:'other',parserVersion,coverageCertified:true})).eligibleSessions,0)
    const unknownParser=await metrics.overview({sourceId:source,parserVersion:'new-parser',coverageCertified:true})
    assert.equal(unknownParser.readySessions,0)
    assert.equal(unknownParser.staleSessions,3)
    assert.equal(unknownParser.missingSessions,1)
    assert.deepEqual(unknownParser.tools,[])
    // Activity-bound range must be respected without scanning Source bodies.
    assert.equal((await metrics.overview({sourceId:source,parserVersion,coverageCertified:true,
      from:'2026-11-01T00:00:00Z'})).eligibleSessions,0)
  }finally{await storage.close()}
})

test('native overview excludes legacy claim even when a numerical cache row exists',async()=>{
  const storage=new SqliteStorageService({path:':memory:'})
  await storage.migrate()
  try{
    const row=location('legacy-only')
    await storage.nativeSessionCatalog.upsert(row)
    assert.equal(await storage.nativeSessionCatalog.claimLegacyWrite(row),'legacy')
    assert.equal(await storage.nativeSessionMetrics.replace(metric('legacy-only')),true)
    const overview=await storage.nativeSessionMetrics.overview({sourceId:source,parserVersion,coverageCertified:true})
    assert.equal(overview.eligibleSessions,0)
    assert.equal(overview.readySessions,0)
    assert.equal(overview.totals.toolCallCount,0)
    assert.deepEqual(overview.tools,[])
  }finally{await storage.close()}
})

test('native metric rebuild candidates paginate fairly when activity timestamps tie',async()=>{
  const storage=new SqliteStorageService({path:':memory:'})
  await storage.migrate()
  try{
    const ids=Array.from({length:9},(_,index)=>`item-${index}`)
    // Same timestamp intentionally exercises the stable installation/native ID tie-break.
    for(const id of ids){
      const row=location(id)
      await storage.nativeSessionCatalog.upsert(row)
      assert.equal(await storage.nativeSessionCatalog.claimNativeOnlyWrite(row),true)
    }
    const metrics=storage.nativeSessionMetrics
    const query={sourceId:source,parserVersion}
    const page1=await metrics.findRebuildCandidates(query,4)
    const last1=page1.at(-1)!
    const page2=await metrics.findRebuildCandidates(query,4,{
      lastActivityAt:last1.lastActivityAt,
      installationId:last1.installationId,
      nativeSessionId:last1.nativeSessionId,
    })
    const last2=page2.at(-1)!
    const page3=await metrics.findRebuildCandidates(query,4,{
      lastActivityAt:last2.lastActivityAt,
      installationId:last2.installationId,
      nativeSessionId:last2.nativeSessionId,
    })
    assert.deepEqual([page1.length,page2.length,page3.length],[4,4,1])
    assert.deepEqual([...page1,...page2,...page3].map(item=>item.nativeSessionId),ids)
    assert.deepEqual([...page1,...page2,...page3].map(item=>item.lastActivityAt),
      ids.map(()=>at))
    await assert.rejects(
      ()=>metrics.findRebuildCandidates(query,4,{
        lastActivityAt:'broken',installationId:installation,nativeSessionId:'item-0',
      }),/Invalid native metric refresh scope/,
    )
  }finally{await storage.close()}
})

test('revoked Source certification instantly masks previously complete Native-only totals',async()=>{
  const storage=new SqliteStorageService({path:':memory:'})
  await storage.migrate()
  try{
    const sourceRow=location('certified-then-revoked')
    await storage.nativeSessionCatalog.upsert(sourceRow)
    assert.equal(await storage.nativeSessionCatalog.claimNativeOnlyWrite(sourceRow),true)
    assert.equal(await storage.nativeSessionMetrics.replace(metric(sourceRow.nativeSessionId)),true)
    const scope={sourceId:source,parserVersion}
    const verified=await storage.nativeSessionMetrics.overview({...scope,coverageCertified:true})
    assert.equal(verified.readySessions,1)
    assert.equal(verified.totals.toolCallCount,3)
    assert.equal(verified.tools.length,1)
    // Changing Source certification is NOT a new file/Parser revision.
    // Historical complete numerical rows must not leak into Usage/Insights.
    for(const query of [{...scope,coverageCertified:false},scope]){
      const revoked=await storage.nativeSessionMetrics.overview(query)
      assert.deepEqual([
        revoked.eligibleSessions,revoked.readySessions,revoked.partialSessions,
        revoked.totals.toolCallCount,revoked.totals.errorCount,
      ],[1,0,1,0,0])
      assert.equal(revoked.totals.inputTokens,null)
      assert.equal(revoked.totals.outputTokens,null)
      assert.deepEqual(revoked.tools,[])
    }
    const recertified=await storage.nativeSessionMetrics.overview({...scope,coverageCertified:true})
    assert.equal(recertified.readySessions,1)
  }finally{await storage.close()}
})

test('slim metrics are scoped by project context, never legacy SQL observations',async()=>{
  const slim=await SqliteSlimStorage.createFresh(':memory:')
  try{
    const host=await slim.identity.resolveHost({name:'local'})
    const install=await slim.identity.resolveInstallation({hostId:host.id,productId:'pi'})
    const p1=await slim.identity.resolveProject({name:'Project One'})
    const p2=await slim.identity.resolveProject({name:'Project Two'})
    assert.ok(p1&&p2)
    for(const [id,projectId] of [['one',p1.id],['two',p2.id]]){
      const native={...location(id),installationId:install.id}
      await slim.nativeSessionCatalog.upsert(native)
      await slim.nativeSessionContexts.upsert({
        sourceId:source,installationId:install.id,nativeSessionId:id,projectId,
      })
      const saved=await slim.nativeSessionMetrics.replace({
        ...metric(id),installationId:install.id,
      })
      assert.equal(saved,true)
    }
    const q={sourceId:source,parserVersion,coverageCertified:true}
    const all=await slim.nativeSessionMetrics.overview(q)
    assert.equal(all.eligibleSessions,2)
    assert.equal(all.totals.toolCallCount,6)
    for(const project of [p1,p2]){
      const scoped=await slim.nativeSessionMetrics.overview({...q,projectId:project.id})
      assert.equal(scoped.eligibleSessions,1)
      assert.equal(scoped.readySessions,1)
      assert.equal(scoped.totals.toolCallCount,3)
      assert.equal(scoped.tools[0]?.callCount,3)
    }
    assert.equal((await slim.nativeSessionMetrics.overview({
      ...q,projectId:'missing-project',
    })).eligibleSessions,0)
    assert.deepEqual(await slim.nativeSessionMetrics.findRebuildCandidates({
      ...q,projectId:p1.id,
    },4),[])
    // A changed original revision makes only its project's metrics stale.
    await slim.nativeSessionCatalog.upsert({
      ...location('one',121),installationId:install.id,
    })
    assert.deepEqual((await slim.nativeSessionMetrics.findRebuildCandidates({
      ...q,projectId:p1.id,
    },4)).map(x=>x.nativeSessionId),['one'])
    assert.deepEqual(await slim.nativeSessionMetrics.findRebuildCandidates({
      ...q,projectId:p2.id,
    },4),[])
  }finally{await slim.close()}
})
