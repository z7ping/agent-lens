import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { SqliteSlimStorage } from './slim-storage'

test('new Slim agent/project filters require no Legacy observations or session summaries',async()=>{
  const slim=await SqliteSlimStorage.createFresh(':memory:')
  try{
    const host=await slim.identity.resolveHost({name:'test-host'})
    const installation=await slim.identity.resolveInstallation({
      hostId:host.id,productId:'pi',dataRoot:resolve('source'),
    })
    const p1=await slim.identity.resolveProject({name:'Project 1'})
    const p2=await slim.identity.resolveProject({name:'Project 2'})
    assert.ok(p1&&p2)
    await slim.nativeSessionCatalog.upsert({
      sourceId:'pi',installationId:installation.id,nativeSessionId:'one',
      locationKind:'native',filePath:resolve('source','session.jsonl'),
      fileIdentity:'1:2',fileSize:128,fileMtimeMs:2,
      lastActivityAt:'2026-10-26T09:00:00Z',updatedAt:'2026-10-26T09:00:00Z',
    })
    await slim.nativeSessionContexts.upsert({
      sourceId:'pi',installationId:installation.id,nativeSessionId:'one',
      projectId:p1.id,
    })
    const result=await slim.nativeFacets.query({projectLimit:1})
    assert.deepEqual(result.installedProducts,[{
      productId:'pi',installationIds:[installation.id],
    }])
    assert.equal(result.projects.length,1)
    assert.equal(result.projectsTruncated,true)
    const all=await slim.nativeFacets.query({projectLimit:20})
    assert.equal(all.projects.length,2)
    assert.equal(all.projectsTruncated,false)
    assert.equal(all.projects.find(x=>x.id===p1.id)?.lastActivityAt,'2026-10-26T09:00:00Z')
    assert.equal(all.projects.find(x=>x.id===p2.id)?.lastActivityAt,undefined)
    assert.equal((slim.db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master
      WHERE name IN ('logical_sessions','source_sessions','observations')`).get() as {n:number}).n,0)
  }finally{await slim.close()}
})
