import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { nativeSqliteRevision } from './native-sqlite-revision'

test('WAL append invalidates derived native revision even when the main SQLite file does not change',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'al-wal-native-'))
  const path=join(dir,'state.db')
  const db=new DatabaseSync(path)
  try{
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('PRAGMA wal_autocheckpoint=0')
    db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, text TEXT)')
    db.exec("INSERT INTO events (text) VALUES ('first')")
    const mainBefore=await stat(path)
    const previous=await nativeSqliteRevision(path,mainBefore)
    db.exec("INSERT INTO events (text) VALUES ('second')")
    const mainAfter=await stat(path)
    const current=await nativeSqliteRevision(path,mainAfter)
    assert.equal(previous.fileIdentity,current.fileIdentity)
    assert.equal(mainAfter.size,mainBefore.size)
    assert.equal(mainAfter.mtimeMs,mainBefore.mtimeMs)
    assert.ok(current.fileSize>previous.fileSize
      || current.fileMtimeMs>previous.fileMtimeMs,
    'WAL changes must invalidate the old metrics revision')
    assert.equal(current.fileIdentity,`${mainAfter.dev}:${mainAfter.ino}`)
    assert.ok(current.fileSize>=mainAfter.size)
  }finally{
    db.close()
    await rm(dir,{recursive:true,force:true})
  }
})

test('legacy no-WAL native file preserves its original catalog revision values',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'al-native-no-wal-'))
  const path=join(dir,'source.sqlite')
  try{
    await writeFile(path,'test fixture for native metadata only')
    const file=await stat(path)
    assert.deepEqual(await nativeSqliteRevision(path,file),{
      fileIdentity:`${file.dev}:${file.ino}`,
      fileSize:file.size,
      fileMtimeMs:file.mtimeMs,
    })
  }finally{await rm(dir,{recursive:true,force:true})}
})
