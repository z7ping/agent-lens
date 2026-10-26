import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import { SqliteSlimStorage } from './slim-storage'
import { SqliteSlimNativeSessionContexts } from './slim-native-session-contexts'
import { SqliteExecutor } from './executor'

test('slim metadata retains project/title association without SQL session or evidence copies',async()=>{
  const storage=await SqliteSlimStorage.createFresh(':memory:')
  try {
    const db=storage.db
    db.exec(`
      INSERT INTO hosts VALUES('h','local','linux','x64','2026-10-26','2026-10-26');
      INSERT INTO agent_products(id,name) VALUES('pi','Pi');
      INSERT INTO agent_installations(id,host_id,product_id,first_seen_at,last_seen_at)
        VALUES('install','h','pi','2026-10-26','2026-10-26');
      INSERT INTO projects(id,name,created_at,last_seen_at)
        VALUES('p1','Project 1','2026-10-26','2026-10-26'),
              ('p2','Project 2','2026-10-26','2026-10-26');
    `)
    const base={sourceId:'pi',installationId:'install'}
    for(const id of ['one','two']) {
      await storage.nativeSessionCatalog.upsert({...base,nativeSessionId:id,
        locationKind:'native',filePath:resolve('source',id+'.jsonl'),
        fileIdentity:'1:2',fileSize:100,fileMtimeMs:1,
        lastActivityAt:'2026-10-26',updatedAt:'2026-10-26'})
    }
    await storage.nativeSessionContexts.upsert({...base,nativeSessionId:'one',
      projectId:'p1',titleOverride:'Saved Title',titleKind:'explicit'})
    await storage.nativeSessionContexts.upsert({...base,nativeSessionId:'two',projectId:'p2'})
    db.exec(`INSERT INTO runtime_profiles(id,installation_id,native_profile_id,
      first_seen_at,last_seen_at) VALUES
      ('profile-one','install','profile-one','2026-10-26','2026-10-26'),
      ('profile-two','install','profile-two','2026-10-26','2026-10-26')`)
    await storage.nativeSessionContexts.upsert({...base,nativeSessionId:'one',
      runtimeProfileId:'profile-one'})
    await assert.rejects(storage.nativeSessionContexts.upsert({
      ...base,nativeSessionId:'one',runtimeProfileId:'profile-two',
    }),/collision/)
    assert.equal((await storage.nativeSessionContexts.get({
      ...base,nativeSessionId:'one',
    }))?.runtimeProfileId,'profile-one')
    await storage.nativeSessionContexts.upsert({...base,nativeSessionId:'one',workspaceId:undefined})
    assert.deepEqual(await storage.nativeSessionContexts.get({...base,nativeSessionId:'one'}),{
      ...base,nativeSessionId:'one',projectId:'p1',titleOverride:'Saved Title',
      titleKind:'explicit',runtimeProfileId:'profile-one',updatedAt:(await storage.nativeSessionContexts.get({
        ...base,nativeSessionId:'one',
      }))!.updatedAt,
    })
    const p1=await storage.nativeSessionCatalog.query({projectId:'p1',limit:10})
    assert.deepEqual(p1.items.map(item=>item.nativeSessionId),['one'])
    const p2=await storage.nativeSessionCatalog.query({projectId:'p2',limit:10})
    assert.deepEqual(p2.items.map(item=>item.nativeSessionId),['two'])
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master
      WHERE name IN ('logical_sessions','observations','source_records')`).get() as {n:number}).n,0)
    await assert.rejects(storage.nativeSessionContexts.upsert({...base,nativeSessionId:'one',
      titleOverride:'unverified first prompt'}),/provenance/)
    await assert.rejects(storage.nativeSessionContexts.upsert({...base,nativeSessionId:'one',
      titleKind:'generated'}),/same update/)
  } finally {await storage.close()}
})

test('native contexts cannot be mounted on legacy tables',()=>{
  const db=new Database(':memory:')
  try{
    db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT)')
    assert.throws(()=>new SqliteSlimNativeSessionContexts(new SqliteExecutor(db)),/slim SQLite/)
  }finally{db.close()}
})
