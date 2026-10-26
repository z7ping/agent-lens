import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp,rm,writeFile,copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteStorageService, SqliteSlimStorage } from '@agent-lens/storage-sqlite'
import { resolveDefaultSlimDb } from './default-slim-db'

test('default main creates only slim v1 on a fresh installation and reuses it',async()=>{
  const dataRoot=await mkdtemp(join(tmpdir(),'al-default-fresh-'))
  try{
    const created=await resolveDefaultSlimDb({dataRoot})
    assert.equal(created.mode,'fresh')
    const next=await resolveDefaultSlimDb({dataRoot})
    assert.equal(next.mode,'existing-slim')
    assert.equal(next.dbPath,created.dbPath)
  }finally{await rm(dataRoot,{force:true,recursive:true})}
})
test('default main refuses v38 rather than invoking retired migration/Writer',async()=>{
  const dataRoot=await mkdtemp(join(tmpdir(),'al-default-old-'))
  try{
    const legacyPath=join(dataRoot,'agent-lens.db')
    const old=new SqliteStorageService({path:legacyPath})
    await old.migrate()
    await old.close()
    await assert.rejects(resolveDefaultSlimDb({dataRoot}),/old v38 Writer is retired/)
    const reopened=new SqliteStorageService({path:legacyPath})
    try{assert.equal((await reopened.health()).schemaVersion,38)}
    finally{await reopened.close()}
  }finally{await rm(dataRoot,{force:true,recursive:true})}
})
test('activated Slim pointer takes precedence; rollback/mismatch/malformed pointer fail closed',async()=>{
  const dataRoot=await mkdtemp(join(tmpdir(),'al-default-upgrade-'))
  try{
    const legacyPath=join(dataRoot,'agent-lens.db')
    const old=new SqliteStorageService({path:legacyPath})
    await old.migrate()
    await old.close()
    await copyFile(legacyPath,join(dataRoot,'old-backup.sqlite'))
    const slimPath=join(dataRoot,'slim-active.sqlite')
    const slim=await SqliteSlimStorage.createFresh(slimPath)
    await slim.close()
    const pointerPath=join(dataRoot,'active-database.json')
    const state={schemaVersion:1,mode:'slim',legacyPath,
      backupPath:join(dataRoot,'old-backup.sqlite'),slimPath,
      changedAt:'2026-10-26T00:00:00.000Z'}
    await writeFile(pointerPath,JSON.stringify(state))
    const active=await resolveDefaultSlimDb({dataRoot})
    assert.equal(active.mode,'activated')
    assert.equal(active.dbPath,slimPath)
    await writeFile(pointerPath,JSON.stringify({...state,mode:'legacy'}))
    await assert.rejects(resolveDefaultSlimDb({dataRoot}),/rolled back/)
    await writeFile(pointerPath,JSON.stringify({...state,mode:'slim',
      legacyPath:join(dataRoot,'another.sqlite')}))
    await assert.rejects(resolveDefaultSlimDb({dataRoot}),/identity mismatch/)
    await writeFile(pointerPath,'not-json')
    await assert.rejects(resolveDefaultSlimDb({dataRoot}),/Unexpected token|JSON/)
  }finally{await rm(dataRoot,{force:true,recursive:true})}
})
