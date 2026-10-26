import assert from 'node:assert/strict'
import test from 'node:test'
import { copyFile, mkdtemp, stat, rm, writeFile } from 'node:fs/promises'
import Database from 'better-sqlite3'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteStorageService, SqliteSlimStorage } from '@agent-lens/storage-sqlite'
import { activateSlimCutover, readActiveDatabasePointer, rollbackSlimCutover } from './slim-cutover-activation'

const allowed={readyToSwitch:true,blockedBy:[],oldDatabaseChanged:false}
test('M3 activation refuses unfinished coverage before touching any destination',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'al-m3-block-'))
  try{
    const paths={legacyPath:join(dir,'old.sqlite'),backupPath:join(dir,'backup.sqlite'),
      stagingPath:join(dir,'stage.sqlite'),installedSlimPath:join(dir,'installed.sqlite'),
      pointerPath:join(dir,'active.json')}
    const old=new SqliteStorageService({path:paths.legacyPath})
    await old.migrate()
    await old.close()
    await assert.rejects(activateSlimCutover(paths,{
      readyToSwitch:false,blockedBy:['hook-and-archival-coverage-not-certified'],
      oldDatabaseChanged:false,
    }),/final Source, Hook, writer and freshness gates/)
    assert.equal(await readActiveDatabasePointer(paths.pointerPath),null)
    await assert.rejects(stat(paths.installedSlimPath),/ENOENT/)
  }finally{await rm(dir,{recursive:true,force:true})}
})
test('guarded activation and rollback preserve the v38 original, backup and Slim files',async()=>{
  const probe=createServer()
  await new Promise<void>(done=>probe.listen(0,'127.0.0.1',done))
  const address=probe.address()
  assert.ok(address&&typeof address!=='string')
  const port=address.port
  await new Promise<void>(done=>probe.close(()=>done()))
  const dir=await mkdtemp(join(tmpdir(),'al-m3-activate-'))
  const paths={legacyPath:join(dir,'old.sqlite'),backupPath:join(dir,'backup.sqlite'),
    stagingPath:join(dir,'stage.sqlite'),installedSlimPath:join(dir,'installed.sqlite'),
    pointerPath:join(dir,'active.json')}
  try{
    const legacy=new SqliteStorageService({path:paths.legacyPath})
    await legacy.migrate()
    await legacy.close()
    await copyFile(paths.legacyPath,paths.backupPath)
    const slim=await SqliteSlimStorage.createFresh(paths.stagingPath)
    await slim.close()
    const activated=await activateSlimCutover(paths,allowed)
    assert.equal(activated.mode,'slim')
    assert.deepEqual(await readActiveDatabasePointer(paths.pointerPath),activated)
    assert.equal((await stat(paths.legacyPath)).isFile(),true)
    assert.equal((await stat(paths.backupPath)).isFile(),true)
    assert.equal((await stat(paths.stagingPath)).ino,(await stat(paths.installedSlimPath)).ino)
    await assert.rejects(activateSlimCutover(paths,allowed),/destination already exists/)
    await assert.rejects(rollbackSlimCutover({
      pointerPath:paths.pointerPath,legacyPath:paths.legacyPath,
      backupPath:paths.backupPath,installedSlimPath:join(dir,'foreign.sqlite'),
      port,
    }),/Rollback identity/)
    const back=await rollbackSlimCutover({
      pointerPath:paths.pointerPath,legacyPath:paths.legacyPath,
      backupPath:paths.backupPath,installedSlimPath:paths.installedSlimPath,
      port,
    })
    assert.equal(back.mode,'legacy')
    assert.equal((await readActiveDatabasePointer(paths.pointerPath))?.mode,'legacy')
    assert.equal((await stat(paths.installedSlimPath)).isFile(),true)
    await assert.rejects(rollbackSlimCutover({
      pointerPath:paths.pointerPath,legacyPath:paths.legacyPath,
      backupPath:paths.backupPath,installedSlimPath:paths.installedSlimPath,
      port,
    }),/No active Slim/)
  }finally{await rm(dir,{recursive:true,force:true})}
})
test('malformed active pointer is a hard error, never a silent Legacy fallback',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'al-m3-pointer-'))
  try{
    const path=join(dir,'active.json')
    await writeFile(path,'{"mode":"slim"}')
    await assert.rejects(readActiveDatabasePointer(path),/Invalid cutover pointer/)
  }finally{await rm(dir,{recursive:true,force:true})}
})


test('M3 cutover rehashes v38 under writer lock, rejecting changes after a previously allowed gate',async()=>{
  const root=await mkdtemp(join(tmpdir(),'al-m3-stale-gate-'))
  const paths={legacyPath:join(root,'old.sqlite'),backupPath:join(root,'backup.sqlite'),
    stagingPath:join(root,'stage.sqlite'),installedSlimPath:join(root,'installed.sqlite'),
    pointerPath:join(root,'active.json')}
  try{
    const legacy=new SqliteStorageService({path:paths.legacyPath})
    await legacy.migrate()
    await legacy.close()
    await copyFile(paths.legacyPath,paths.backupPath)
    const slim=await SqliteSlimStorage.createFresh(paths.stagingPath)
    await slim.close()
    const changed=new Database(paths.legacyPath)
    try{changed.exec(`CREATE TABLE m3_race_detected (id INTEGER PRIMARY KEY)`)}
    finally{changed.close()}
    await assert.rejects(activateSlimCutover(paths,allowed),
      /Legacy database drifted from the M3 backup/)
    assert.equal(await readActiveDatabasePointer(paths.pointerPath),null)
    await assert.rejects(stat(paths.installedSlimPath),/ENOENT/)
  }finally{await rm(root,{force:true,recursive:true})}
})


test('activation computes the final gate inside the frozen old SQLite transaction',async()=>{
  const root=await mkdtemp(join(tmpdir(),'al-m3-conditional-gate-'))
  const paths={legacyPath:join(root,'old.sqlite'),backupPath:join(root,'backup.sqlite'),
    stagingPath:join(root,'stage.sqlite'),installedSlimPath:join(root,'installed.sqlite'),
    pointerPath:join(root,'active.json')}
  try{
    const db=new SqliteStorageService({path:paths.legacyPath})
    await db.migrate();await db.close()
    await copyFile(paths.legacyPath,paths.backupPath)
    const staging=await SqliteSlimStorage.createFresh(paths.stagingPath)
    await staging.close()
    let evaluated=false
    await assert.rejects(activateSlimCutover(paths,async()=>{
      evaluated=true
      const concurrent=new Database(paths.legacyPath,{timeout:0})
      try{assert.throws(()=>concurrent.exec('BEGIN IMMEDIATE'),/locked|SQLITE_BUSY/)}
      finally{concurrent.close()}
      return {readyToSwitch:false,blockedBy:['not-certified'],oldDatabaseChanged:false}
    }),/Cutover blocked/)
    assert.equal(evaluated,true)
    assert.equal(await readActiveDatabasePointer(paths.pointerPath),null)
  }finally{await rm(root,{recursive:true,force:true})}
})


test('M3 rollback refuses an active Daemon port and preserves the Slim pointer',async()=>{
  const root=await mkdtemp(join(tmpdir(),'al-m3-live-rollback-'))
  const paths={legacyPath:join(root,'old.sqlite'),backupPath:join(root,'backup.sqlite'),
    stagingPath:join(root,'stage.sqlite'),installedSlimPath:join(root,'installed.sqlite'),
    pointerPath:join(root,'active.json')}
  const server=createServer(socket=>socket.end())
  try{
    const old=new SqliteStorageService({path:paths.legacyPath})
    await old.migrate();await old.close()
    await copyFile(paths.legacyPath,paths.backupPath)
    const stage=await SqliteSlimStorage.createFresh(paths.stagingPath)
    await stage.close()
    const pointer=await activateSlimCutover(paths,allowed)
    await new Promise<void>((yes,no)=>{
      server.once('error',no)
      server.listen(0,'127.0.0.1',()=>yes())
    })
    const address=server.address()
    assert.ok(address && typeof address!=='string')
    const port=address.port
    await assert.rejects(rollbackSlimCutover({
      pointerPath:paths.pointerPath,legacyPath:paths.legacyPath,
      backupPath:paths.backupPath,installedSlimPath:paths.installedSlimPath,
      port,
    }),/Daemon port occupied/)
    assert.deepEqual(await readActiveDatabasePointer(paths.pointerPath),pointer)
  }finally{
    await new Promise<void>(done=>server.close(()=>done()))
    await rm(root,{force:true,recursive:true})
  }
})


test('failed pointer publication cleans ONLY the newly created hard link, preserving stage and v38',async()=>{
  const root=await mkdtemp(join(tmpdir(),'al-m3-pointer-failure-'))
  const paths={legacyPath:join(root,'old.sqlite'),backupPath:join(root,'backup.sqlite'),
    stagingPath:join(root,'stage.sqlite'),installedSlimPath:join(root,'installed.sqlite'),
    // Parent directory deliberately missing: pointer write fails *after* the
    // exclusive hard link, recreating an interrupted activation publication.
    pointerPath:join(root,'absent-directory','active.json')}
  try{
    const old=new SqliteStorageService({path:paths.legacyPath})
    await old.migrate();await old.close()
    await copyFile(paths.legacyPath,paths.backupPath)
    const stage=await SqliteSlimStorage.createFresh(paths.stagingPath)
    await stage.close()
    await assert.rejects(activateSlimCutover(paths,allowed),/ENOENT|no such file/i)
    await assert.rejects(stat(paths.installedSlimPath),/ENOENT/)
    assert.equal((await stat(paths.stagingPath)).isFile(),true)
    assert.equal((await stat(paths.legacyPath)).isFile(),true)
    assert.equal((await stat(paths.backupPath)).isFile(),true)
    assert.equal(await readActiveDatabasePointer(paths.pointerPath),null)
  }finally{await rm(root,{force:true,recursive:true})}
})
