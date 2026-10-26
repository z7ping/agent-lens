import { LegacyV38TestDatabase } from '../packages/storage-sqlite/src/legacy-v38-test-fixture'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

import { withFrozenLegacyWriter } from './slim-legacy-writer-freeze'

test('M3 freeze blocks concurrent v38 writes until the entire finalizer completes',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'al-m3-lock-'))
  const legacyPath=join(dir,'legacy.sqlite')
  try{
    const storage=new LegacyV38TestDatabase({path:legacyPath})
    await storage.migrate()
    await storage.close()
    await withFrozenLegacyWriter(legacyPath,async()=>{
      const second=new Database(legacyPath,{timeout:0})
      try{
        assert.equal((second.prepare('SELECT count(*) AS n FROM hosts').get() as {n:number}).n,0)
        assert.throws(()=>second.prepare(`INSERT INTO hosts(id,name,platform,arch,created_at,last_seen_at)
          VALUES ('test','test','linux','x64','2026-10-26','2026-10-26')`).run(),/database is locked|SQLITE_BUSY/)
      }finally{second.close()}
    })
    const writer=new Database(legacyPath)
    try{
      writer.prepare(`INSERT INTO hosts(id,name,platform,arch,created_at,last_seen_at)
        VALUES ('test','test','linux','x64','2026-10-26','2026-10-26')`).run()
      assert.equal((writer.prepare('SELECT count(*) AS n FROM hosts').get() as {n:number}).n,1)
    }finally{writer.close()}
  }finally{await rm(dir,{recursive:true,force:true})}
})

test('M3 freeze always releases after thrown finalizer and rejects wrong schema',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'al-m3-lock-exception-'))
  const legacyPath=join(dir,'legacy.sqlite')
  try{
    const storage=new LegacyV38TestDatabase({path:legacyPath})
    await storage.migrate()
    await storage.close()
    await assert.rejects(withFrozenLegacyWriter(legacyPath,async()=>{
      throw new Error('source integrity failed')
    }),/source integrity failed/)
    const reopened=new Database(legacyPath,{timeout:0})
    try{
      reopened.exec('BEGIN IMMEDIATE')
      reopened.exec('ROLLBACK')
    }finally{reopened.close()}
    await assert.rejects(withFrozenLegacyWriter(join(dir,'missing.sqlite'),
      async()=>undefined),/unable to open|does not exist/i)
  }finally{await rm(dir,{recursive:true,force:true})}
})
