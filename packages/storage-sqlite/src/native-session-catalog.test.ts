import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { SqliteSlimStorage } from './slim-storage'

const at='2026-10-26T00:00:00.000Z'

async function fixture() {
  const storage=await SqliteSlimStorage.createFresh(':memory:')
  storage.db.exec(`
    INSERT INTO hosts(id,name,platform,arch,created_at,last_seen_at)
      VALUES ('host','local','linux','x64','2026-10-26','2026-10-26');
    INSERT INTO agent_products(id,name) VALUES ('pi','Pi');
    INSERT INTO agent_installations(id,host_id,product_id,first_seen_at,last_seen_at)
      VALUES ('local-pi','host','pi','2026-10-26','2026-10-26');
  `)
  return storage
}
const location=(id:string,lastActivityAt=at)=>({
  sourceId:'pi',installationId:'local-pi',nativeSessionId:id,
  locationKind:'native' as const,filePath:resolve('fixtures',id+'.jsonl'),
  fileIdentity:'inode:'+id,fileSize:200,fileMtimeMs:10,
  lastActivityAt,updatedAt:at,
})

test('Slim Native Catalog stores stable metadata and independently paginates sessions',async()=>{
  const storage=await fixture()
  try {
    const catalog=storage.nativeSessionCatalog
    for(const [id,activity] of [
      ['old','2026-10-20T00:00:00.000Z'],
      ['middle','2026-10-22T00:00:00.000Z'],
      ['new','2026-10-24T00:00:00.000Z'],
    ]) await catalog.upsert(location(id!,activity!))
    await catalog.upsert({...location('middle','2026-10-21T00:00:00.000Z'),title:'Readable title'})
    assert.equal((await catalog.get({sourceId:'pi',installationId:'local-pi',nativeSessionId:'middle'}))?.lastActivityAt,
      '2026-10-22T00:00:00.000Z')
    assert.deepEqual((await catalog.query({search:'READABLE',limit:10})).items.map(x=>x.nativeSessionId),['middle'])
    const first=await catalog.query({limit:2})
    assert.deepEqual(first.items.map(x=>x.nativeSessionId),['new','middle'])
    assert.equal(first.hasMore,true)
    const second=await catalog.query({limit:2,before:{
      lastActivityAt:first.items[1]!.lastActivityAt,sourceId:'pi',installationId:'local-pi',
      nativeSessionId:'middle',locationKind:'native',
    }})
    assert.deepEqual(second.items.map(x=>x.nativeSessionId),['old'])
  }finally{await storage.close()}
})

test('Slim numerical eligibility is original native location, never SQL writer ownership',async()=>{
  const storage=await fixture()
  try {
    const catalog=storage.nativeSessionCatalog
    const identity={sourceId:'pi',installationId:'local-pi',nativeSessionId:'a'}
    assert.equal(await catalog.isNativeMetricsEligible(identity),false)
    await catalog.upsert(location('a'))
    assert.equal(await catalog.isNativeMetricsEligible(identity),true)
    assert.equal('claimLegacyWrite' in catalog,false)
    assert.equal('claimNativeOnlyWrite' in catalog,false)
    assert.equal('getSessionWriteMode' in catalog,false)
    assert.equal('hasNativeOnlyWriteClaim' in catalog,false)
    const tables=storage.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name:string}>
    assert.equal(tables.some(row=>row.name==='native_session_write_claims'),false)
  }finally{await storage.close()}
})
