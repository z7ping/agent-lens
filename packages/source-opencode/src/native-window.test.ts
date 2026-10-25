import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import type { SourceRawRecoveryContext } from '@agent-lens/core'
import { OPENCODE_DB_NAME } from '@agent-lens/runtime-cordis'
import { openCodeSourceDefinition } from './index'

const at='2026-10-25T07:00:00Z'

test('OpenCode native SQLite reads only one session with an exact rowid rewind cursor',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-opencode-native-'))
  const path=join(root,OPENCODE_DB_NAME)
  const db=new DatabaseSync(path)
  try{
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY,directory TEXT,title TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY,data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,data TEXT)`)
    db.prepare('INSERT INTO session (id,directory,title) VALUES (?,?,?)').run('S1',root,'Test')
    for(const [id,sid,txt] of [['p1','S1','first'],['p2','other','foreign'],['p3','S1','second']]){
      db.prepare('INSERT INTO message (id,data) VALUES (?,?)').run('m-'+id,JSON.stringify({role:'user'}))
      db.prepare('INSERT INTO part (id,message_id,session_id,time_created,data) VALUES (?,?,?,?,?)')
        .run(id,'m-'+id,sid,1_790_000_000_000,JSON.stringify({type:'text',text:txt}))
    }
    const host:SourceRawRecoveryContext['host']={
      id:'host',name:'local',platform:process.platform,arch:process.arch,createdAt:at,lastSeenAt:at,
    }
    const installation:SourceRawRecoveryContext['installation']={
      id:'opencode-inst',hostId:host.id,productId:'opencode',dataRoot:root,
      firstSeenAt:at,lastSeenAt:at,
    }
    const catalogRows=[]
    for await (const entry of openCodeSourceDefinition.discoverNativeSessions!({
      host,installation,abortSignal:new AbortController().signal,
      checkpoint:{async get(){return null},async set(){throw Error('No catalog checkpoint write')},async clear(){}},
      historyWindow:{sessionLimit:1},
    })) catalogRows.push(entry)
    assert.equal(catalogRows.length,1)
    assert.equal(catalogRows[0]?.nativeSessionId,'S1')
    assert.equal(catalogRows[0]?.title,'Test')
    assert.equal(catalogRows[0]?.filePath,path)
    assert.equal(catalogRows[0]?.fileSize,(await stat(path)).size)
    assert.equal(JSON.stringify(catalogRows).includes('first'),false)
    let writes=0
    const ctx:SourceRawRecoveryContext={
      host,installation,abortSignal:new AbortController().signal,
      checkpoint:{async get(){return null},async set(){writes++},async clear(){writes++}},
    }
    const read=openCodeSourceDefinition.readNativeSessionPage!
    const first=await read({filePath:path,nativeSessionId:'S1',limit:1},ctx)
    assert.equal(first.state,'available')
    if(first.state!=='available')return
    assert.deepEqual(first.records.map(x=>x.nativeId),['p1'])
    assert.equal(first.recordCursors?.[0]?.offset,0)
    assert.equal(first.hasMore,true)
    const second=await read({filePath:path,nativeSessionId:'S1',cursor:first.nextCursor,limit:1},ctx)
    assert.equal(second.state,'available')
    if(second.state!=='available')return
    assert.deepEqual(second.records.map(x=>x.nativeId),['p3'])
    assert.equal(second.recordCursors?.[0]?.offset,2)
    assert.equal(second.nextCursor.offset,3)
    assert.equal(second.hasMore,false)
    assert.equal(writes,0)
    const normalized=await openCodeSourceDefinition.normalize(second.records[0]!,{host,installation})
    assert.ok(Array.isArray(normalized.observations))
    const info=await stat(path)
    assert.equal(second.nextCursor.fileIdentity,`${info.dev}:${info.ino}`)
    assert.deepEqual(await read({
      filePath:path,nativeSessionId:'S1',cursor:{...second.nextCursor,fileIdentity:'changed'},
    },ctx),{state:'drifted',reason:'native-file-identity-changed'})
  }finally{db.close();await rm(root,{recursive:true,force:true})}
})
