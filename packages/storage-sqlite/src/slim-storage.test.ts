import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SqliteSlimStorage } from './slim-storage'
import { SqliteStorageService } from './storage'
import { assertSlimSchema } from './slim-schema'

test('new slim runtime composes only native/metadata repositories and reopens without v38 migrations',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'agent-lens-slim-runtime-'))
  const path=join(directory,'new.sqlite')
  try {
    const slim=await SqliteSlimStorage.createFresh(path)
    try {
      assertSlimSchema(slim.db)
      assert.equal(slim.db.readonly,false)
      const forbidden=['repositories','sessionSummaries','sourceRawAudit',
        'replication','toolUsageObservations','projectionBackfill']
      for(const key of forbidden) {
        assert.equal(key in slim,false,key)
      }
      const session={sourceId:'pi',installationId:'install',nativeSessionId:'s',
        locationKind:'native' as const,filePath:resolve('sessions/s.jsonl'),
        fileIdentity:'1:2',fileSize:100,fileMtimeMs:1,
        lastActivityAt:'2026-10-26T00:00:00.000Z',updatedAt:'2026-10-26T00:00:00.000Z'}
      await slim.nativeSessionCatalog.upsert(session)
      assert.equal((await slim.nativeSessionCatalog.query()).items.length,1)
      await slim.checkpoints.set('safe-metadata','pointer',{version:1})
      assert.deepEqual(await slim.checkpoints.get('safe-metadata','pointer'),{version:1})
    }finally {await slim.close()}
    const readOnly=SqliteSlimStorage.openExisting(path,true)
    try {
      assert.equal(readOnly.db.readonly,true)
      assert.equal((await readOnly.nativeSessionCatalog.query()).items.length,1)
      await assert.rejects(readOnly.nativeSessionCatalog.claimLegacyWrite({
        sourceId:'pi',installationId:'install',nativeSessionId:'s',
      }),/forbidden/)
    }finally{await readOnly.close()}
    await assert.rejects(SqliteSlimStorage.createFresh(path),/EEXIST/)
  }finally{await rm(directory,{recursive:true,force:true})}
})

test('slim runtime cannot open old 38-migration database or absent file',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'agent-lens-slim-reject-'))
  const legacyPath=join(directory,'legacy.sqlite')
  try {
    const legacy=new SqliteStorageService({path:legacyPath})
    try{await legacy.migrate()}finally{await legacy.close()}
    assert.throws(()=>SqliteSlimStorage.openExisting(legacyPath),/missing|required|Slim database/)
    assert.throws(()=>SqliteSlimStorage.openExisting(join(directory,'missing.sqlite')),/SQLITE_CANTOPEN/)
  }finally{await rm(directory,{recursive:true,force:true})}
})

test('in-memory slim runtime bootstraps independently of v38',async()=>{
  const slim=await SqliteSlimStorage.createFresh(':memory:')
  try{
    assertSlimSchema(slim.db)
    assert.equal((slim.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations')
      .get() as {n:number}).n,1)
  }finally{await slim.close()}
})
