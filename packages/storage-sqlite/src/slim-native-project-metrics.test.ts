import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { NATIVE_SESSION_METRIC_PROJECTION_VERSION } from '@agent-lens/core'
import { SqliteSlimStorage } from './slim-storage'

const at='2026-10-26T00:00:00Z'
test('slim numeric Overview and repair queue filter project without legacy session/event tables',async()=>{
  const slim=await SqliteSlimStorage.createFresh(':memory:')
  try{
    const host=await slim.identity.resolveHost({name:'localhost'})
    const installation=await slim.identity.resolveInstallation({
      hostId:host.id,productId:'pi',dataRoot:resolve('native'),
    })
    const p1=await slim.identity.resolveProject({name:'project-a'})
    const p2=await slim.identity.resolveProject({name:'project-b'})
    assert.ok(p1&&p2)
    for(const [id,project] of [['one',p1],['two',p2]] as const){
      await slim.nativeSessionCatalog.upsert({
        sourceId:'pi',installationId:installation.id,nativeSessionId:id,
        locationKind:'native',filePath:resolve('sessions',id+'.jsonl'),
        fileIdentity:id,fileSize:100,fileMtimeMs:2,
        lastActivityAt:at,updatedAt:at,
      })
      await slim.nativeSessionContexts.upsert({
        sourceId:'pi',installationId:installation.id,nativeSessionId:id,
        projectId:project.id,
      })
    }
    assert.equal(await slim.nativeSessionMetrics.replace({
      sourceId:'pi',installationId:installation.id,nativeSessionId:'one',
      fileIdentity:'one',fileSize:100,fileMtimeMs:2,
      parserVersion:'pi-v1',projectionVersion:NATIVE_SESSION_METRIC_PROJECTION_VERSION,
      coverage:'complete',interactionCount:1,toolCallCount:2,
      toolResultCount:2,toolErrorCount:0,errorCount:0,
      inputTokens:25,outputTokens:10,
      tools:[{nativeToolName:'shell',callCount:2,resultCount:2,errorCount:0,totalDurationMs:10}],
      computedAt:at,
    }),true)
    const query={sourceId:'pi',parserVersion:'pi-v1',coverageCertified:true}
    const one=await slim.nativeSessionMetrics.overview({...query,projectId:p1.id})
    assert.equal(one.eligibleSessions,1)
    assert.equal(one.readySessions,1)
    assert.equal(one.totals.toolCallCount,2)
    assert.equal(one.tools[0]?.nativeToolName,'shell')
    const other=await slim.nativeSessionMetrics.overview({...query,projectId:p2.id})
    assert.equal(other.eligibleSessions,1)
    assert.equal(other.missingSessions,1)
    assert.equal(other.totals.toolCallCount,0)
    assert.equal(other.tools.length,0)
    const pending=await slim.nativeSessionMetrics.findRebuildCandidates({
      ...query,projectId:p2.id,
    },4)
    assert.deepEqual(pending.map(row=>row.nativeSessionId),['two'])
    assert.deepEqual((await slim.nativeSessionMetrics.findRebuildCandidates({
      ...query,projectId:p1.id,
    },4)).map(row=>row.nativeSessionId),[])
  }finally{await slim.close()}
})
