import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import {
  NATIVE_SESSION_METRIC_PROJECTION_VERSION,
  type NativeSessionMetricSnapshot,
} from '@agent-lens/core'
import {SqliteStorageService} from './storage'

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

    const overview=await metrics.overview({sourceId:source,parserVersion})
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
    assert.equal((await metrics.overview({sourceId:'other',parserVersion})).eligibleSessions,0)
    const unknownParser=await metrics.overview({sourceId:source,parserVersion:'new-parser'})
    assert.equal(unknownParser.readySessions,0)
    assert.equal(unknownParser.staleSessions,3)
    assert.equal(unknownParser.missingSessions,1)
    assert.deepEqual(unknownParser.tools,[])
    // Activity-bound range must be respected without scanning Source bodies.
    assert.equal((await metrics.overview({sourceId:source,parserVersion,
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
    const overview=await storage.nativeSessionMetrics.overview({sourceId:source,parserVersion})
    assert.equal(overview.eligibleSessions,0)
    assert.equal(overview.readySessions,0)
    assert.equal(overview.totals.toolCallCount,0)
    assert.deepEqual(overview.tools,[])
  }finally{await storage.close()}
})
