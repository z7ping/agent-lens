import assert from 'node:assert/strict'
import test from 'node:test'
import { copyFile, mkdtemp, stat, rm, writeFile } from 'node:fs/promises'
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
    await assert.rejects(activateSlimCutover(paths,{
      readyToSwitch:false,blockedBy:['hook-and-archival-coverage-not-certified'],
      oldDatabaseChanged:false,
    }),/final Source, Hook, writer and freshness gates/)
    assert.equal(await readActiveDatabasePointer(paths.pointerPath),null)
    await assert.rejects(stat(paths.installedSlimPath),/ENOENT/)
  }finally{await rm(dir,{recursive:true,force:true})}
})
test('guarded activation and rollback preserve the v38 original, backup and Slim files',async()=>{
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
    }),/Rollback identity/)
    const back=await rollbackSlimCutover({
      pointerPath:paths.pointerPath,legacyPath:paths.legacyPath,
      backupPath:paths.backupPath,installedSlimPath:paths.installedSlimPath,
    })
    assert.equal(back.mode,'legacy')
    assert.equal((await readActiveDatabasePointer(paths.pointerPath))?.mode,'legacy')
    assert.equal((await stat(paths.installedSlimPath)).isFile(),true)
    await assert.rejects(rollbackSlimCutover({
      pointerPath:paths.pointerPath,legacyPath:paths.legacyPath,
      backupPath:paths.backupPath,installedSlimPath:paths.installedSlimPath,
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
