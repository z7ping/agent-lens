import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { NATIVE_SESSION_METRIC_PROJECTION_VERSION } from '@agent-lens/core'
import { SqliteSlimStorage } from './slim-storage'

const timestamp='2026-10-26T00:00:00.000Z'
test('slim session list reads native titles/projects and never guesses missing stats as zero',async()=>{
  const slim=await SqliteSlimStorage.createFresh(':memory:')
  try{
    const host=await slim.identity.resolveHost({name:'localhost'})
    const install=await slim.identity.resolveInstallation({
      hostId:host.id,productId:'pi',dataRoot:resolve('native'),
    })
    const project=await slim.identity.resolveProject({name:'P1'})
    assert.ok(project)
    for (const [id,date] of [['one','2026-10-26T02:00:00Z'],
      ['two','2026-10-26T01:00:00Z']] as const) {
      await slim.nativeSessionCatalog.upsert({
        sourceId:'pi',installationId:install.id,nativeSessionId:id,
        locationKind:'native',filePath:resolve('private-native',id+'.jsonl'),
        fileIdentity:'1:2',fileSize:120,fileMtimeMs:5,
        lastActivityAt:date,updatedAt:timestamp,title:'Native '+id,
      })
    }
    await slim.nativeSessionContexts.upsert({
      sourceId:'pi',installationId:install.id,nativeSessionId:'one',
      projectId:project.id,titleOverride:'User saved title',titleKind:'explicit',
    })
    const page=await slim.nativeSessionList.query({sourceId:'pi',limit:1})
    assert.equal(page.hasMore,true)
    assert.equal(page.items[0]?.nativeSessionId,'one')
    assert.equal(page.items[0]?.title,'User saved title')
    assert.equal(page.items[0]?.titleProvenance,'explicit')
    assert.equal(page.items[0]?.metricsState,'missing')
    assert.equal(page.items[0]?.metrics,undefined)
    assert.equal(page.items[0]?.projectId,project.id)
    assert.equal(JSON.stringify(page).includes('private-native'),false)
    const later=await slim.nativeSessionList.query({
      sourceId:'pi',limit:5,
      before:{
        lastActivityAt:page.items[0]!.lastActivityAt,
        sourceId:page.items[0]!.sourceId,
        installationId:page.items[0]!.installationId,
        nativeSessionId:page.items[0]!.nativeSessionId,
      },
    })
    assert.deepEqual(later.items.map(x=>x.nativeSessionId),['two'])
    const direct=await slim.nativeSessionList.query({
      reviewSessionId:page.items[0]!.reviewSessionId,limit:1,
    })
    assert.equal(direct.items.length,1)
    assert.equal(direct.items[0]?.title,'User saved title')
    assert.equal(direct.items[0]?.projectId,project.id)
    assert.equal(direct.items[0]?.titleProvenance,'explicit')
    assert.deepEqual((await slim.nativeSessionList.query({
      reviewSessionId:'native:missing',limit:1,
    })).items,[])
    const scoped=await slim.nativeSessionList.query({projectId:project.id,limit:5})
    assert.deepEqual(scoped.items.map(x=>x.nativeSessionId),['one'])
    assert.equal(later.items[0]?.titleProvenance,'native')
  }finally{await slim.close()}
})

test('unfiltered multi-Agent lists validate metrics against each Source independently',async()=>{
  const slim=await SqliteSlimStorage.createFresh(':memory:')
  try{
    for(const [sourceId,parserVersion] of [['pi','pi-v1'],['codex','codex-v2']] as const){
      await slim.nativeSessionCatalog.upsert({
        sourceId,installationId:'install',nativeSessionId:sourceId,
        locationKind:'native',filePath:resolve('native',sourceId+'.jsonl'),
        fileIdentity:sourceId,fileSize:100,fileMtimeMs:2,
        lastActivityAt:timestamp,updatedAt:timestamp,
      })
      assert.equal(await slim.nativeSessionMetrics.replace({
        sourceId,installationId:'install',nativeSessionId:sourceId,
        fileIdentity:sourceId,fileSize:100,fileMtimeMs:2,
        parserVersion,projectionVersion:NATIVE_SESSION_METRIC_PROJECTION_VERSION,
        coverage:'complete',interactionCount:2,toolCallCount:1,toolResultCount:1,
        toolErrorCount:0,errorCount:0,inputTokens:null,outputTokens:null,
        tools:[],computedAt:timestamp,
      }),true)
    }
    const query={limit:5,sourceCertifications:[
      {sourceId:'pi',parserVersion:'pi-v1',coverageCertified:true},
      {sourceId:'codex',parserVersion:'codex-v2',coverageCertified:false},
    ]}
    const mixed=await slim.nativeSessionList.query(query)
    const bySource=new Map(mixed.items.map(item=>[item.sourceId,item]))
    assert.equal(bySource.get('pi')?.metricsState,'complete')
    assert.equal(bySource.get('codex')?.metricsState,'partial')
    const changed=await slim.nativeSessionList.query({limit:5,sourceCertifications:[
      {sourceId:'pi',parserVersion:'pi-v2',coverageCertified:true},
      {sourceId:'codex',parserVersion:'codex-v2',coverageCertified:true},
    ]})
    const revised=new Map(changed.items.map(item=>[item.sourceId,item]))
    assert.equal(revised.get('pi')?.metricsState,'stale')
    assert.equal(revised.get('pi')?.metrics,undefined)
    assert.equal(revised.get('codex')?.metricsState,'complete')
    const unavailable=await slim.nativeSessionList.query({limit:5,sourceCertifications:[]})
    assert.equal(unavailable.items.every(item=>item.metricsState==='stale'),true)
    assert.throws(()=>slim.nativeSessionList.query({limit:5,sourceCertifications:[
      {sourceId:'pi',parserVersion:'pi-v1',coverageCertified:true},
      {sourceId:'pi',parserVersion:'pi-v1',coverageCertified:false},
    ]}),/certifications/)
  }finally{await slim.close()}
})

test('slim list distinguishes certified/current, partial and stale metrics',async()=>{
  const slim=await SqliteSlimStorage.createFresh(':memory:')
  try{
    await slim.nativeSessionCatalog.upsert({
      sourceId:'pi',installationId:'install',nativeSessionId:'s',
      locationKind:'native',filePath:resolve('safe','s.jsonl'),
      fileIdentity:'1:2',fileSize:300,fileMtimeMs:5,
      lastActivityAt:timestamp,updatedAt:timestamp,
    })
    assert.equal(await slim.nativeSessionMetrics.replace({
      sourceId:'pi',installationId:'install',nativeSessionId:'s',
      fileIdentity:'1:2',fileSize:300,fileMtimeMs:5,
      parserVersion:'parser-v1',projectionVersion:NATIVE_SESSION_METRIC_PROJECTION_VERSION,
      coverage:'complete',interactionCount:3,toolCallCount:2,toolResultCount:2,
      toolErrorCount:1,errorCount:1,inputTokens:400,outputTokens:100,
      tools:[],computedAt:timestamp,
    }),true)
    const query={sourceId:'pi',limit:5,parserVersion:'parser-v1',coverageCertified:true}
    let first=await slim.nativeSessionList.query(query)
    assert.equal(first.items[0]?.metricsState,'complete')
    assert.equal(first.items[0]?.metrics?.toolCallCount,2)
    first=await slim.nativeSessionList.query({...query,coverageCertified:false})
    assert.equal(first.items[0]?.metricsState,'partial')
    first=await slim.nativeSessionList.query({...query,parserVersion:'parser-v2'})
    assert.equal(first.items[0]?.metricsState,'stale')
    assert.equal(first.items[0]?.metrics,undefined)
    await slim.nativeSessionCatalog.upsert({
      sourceId:'pi',installationId:'install',nativeSessionId:'s',
      locationKind:'native',filePath:resolve('safe','s.jsonl'),
      fileIdentity:'2:2',fileSize:200,fileMtimeMs:8,
      lastActivityAt:timestamp,updatedAt:timestamp,
    })
    first=await slim.nativeSessionList.query(query)
    assert.equal(first.items[0]?.metricsState,'stale')
    assert.equal(first.items[0]?.metrics,undefined)
  }finally{await slim.close()}
})
