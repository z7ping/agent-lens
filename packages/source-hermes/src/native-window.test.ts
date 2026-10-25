import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import type { SourceRawRecoveryContext, SourceRecord } from '@agent-lens/core'
import { archiveAcceptedHookInboxFile, archivedHookInboxRecordPath } from '@agent-lens/source-support'
import { HERMES_STATE_DB_NAME } from '@agent-lens/runtime-cordis'
import { hermesSourceDefinition } from './index'

const at='2026-10-25T07:00:00Z'

test('Hermes native SQLite pages isolate session rows and normalize with no checkpoints',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-hermes-native-'))
  const path=join(root,HERMES_STATE_DB_NAME)
  const db=new DatabaseSync(path)
  try {
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY,cwd TEXT,title TEXT);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,
        timestamp TEXT,tool_calls TEXT,tool_call_id TEXT,tool_name TEXT
      )`)
    db.prepare('INSERT INTO sessions (id,cwd,title) VALUES (?,?,?)').run('S1',root,'Session')
    for(const [id,sid,text] of [['m1','S1','first'],['m2','OTHER','unrelated'],['m3','S1','second']]){
      db.prepare('INSERT INTO messages (id,session_id,role,content,timestamp) VALUES (?,?,?,?,?)')
        .run(id,sid,'user',JSON.stringify(text),at)
    }
    const host:SourceRawRecoveryContext['host']={
      id:'host',name:'local',platform:process.platform,arch:process.arch,createdAt:at,lastSeenAt:at,
    }
    const installation:SourceRawRecoveryContext['installation']={
      id:'hermes-inst',hostId:host.id,productId:'hermes',
      dataRoot:root,firstSeenAt:at,lastSeenAt:at,
    }
    const catalogRows=[]
    const catalogContext={
      host,installation,abortSignal:new AbortController().signal,
      checkpoint:{async get(){return null},async set(){throw Error('No catalog checkpoint write')},async clear(){}},
      historyWindow:{sessionLimit:1},
    } as const
    for await (const entry of hermesSourceDefinition.discoverNativeSessions!(catalogContext)) catalogRows.push(entry)
    assert.equal(catalogRows.length,1)
    assert.equal(catalogRows[0]?.nativeSessionId,'S1')
    assert.equal(catalogRows[0]?.title,'Session')
    assert.equal(catalogRows[0]?.filePath,path)
    assert.equal(catalogRows[0]?.fileSize,(await stat(path)).size)
    assert.equal(JSON.stringify(catalogRows).includes('first'),false)
    assert.equal(JSON.stringify(catalogRows).includes('second'),false)
    let checkpointWrites=0
    const ctx:SourceRawRecoveryContext={
      host,installation,abortSignal:new AbortController().signal,
      checkpoint:{async get(){return null},async set(){checkpointWrites++},async clear(){checkpointWrites++}},
    }
    const first=await hermesSourceDefinition.readNativeSessionPage!({
      filePath:path,nativeSessionId:'S1',limit:1,
    },ctx)
    assert.equal(first.state,'available')
    if(first.state!=='available')return
    assert.deepEqual(first.records.map(x=>x.nativeId),['m1'])
    assert.deepEqual(first.recordCursors?.map(x=>x.offset),[0])
    assert.equal(first.hasMore,true)
    const second=await hermesSourceDefinition.readNativeSessionPage!({
      filePath:path,nativeSessionId:'S1',limit:1,cursor:first.nextCursor,
    },ctx)
    assert.equal(second.state,'available')
    if(second.state!=='available')return
    assert.deepEqual(second.records.map(x=>x.nativeId),['m3'])
    assert.deepEqual(second.recordCursors?.map(x=>x.offset),[2])
    assert.equal(second.nextCursor.offset,3)
    assert.equal(second.hasMore,false)
    assert.equal(checkpointWrites,0)
    const legacyRecords=[]
    for await(const record of hermesSourceDefinition.ingestHistory!({
      ...ctx,skipNativeSessionId:id=>id==='S1',
    })) legacyRecords.push(record)
    assert.deepEqual(legacyRecords.map(item=>item.sourceSessionNativeId),['OTHER'],
      'shared Hermes SQLite must retain Legacy rows from a different session')
    const normalized=await hermesSourceDefinition.normalize(second.records[0]!,{host,installation})
    assert.ok(Array.isArray(normalized.observations))
    const info=await stat(path)
    assert.equal(second.nextCursor.fileIdentity,`${info.dev}:${info.ino}`)
    const mismatch=await hermesSourceDefinition.readNativeSessionPage!({
      filePath:path,nativeSessionId:'S1',cursor:{...second.nextCursor,fileIdentity:'forged'},
    },ctx)
    assert.deepEqual(mismatch,{state:'drifted',reason:'native-file-identity-changed'})
    const foreign=await hermesSourceDefinition.readNativeSessionPage!({
      filePath:join(root,'foreign.db'),nativeSessionId:'S1',
    },ctx)
    assert.notEqual(foreign.state,'available')
    const capability=hermesSourceDefinition.rawRecovery!.describe(second.records[0]!)
    assert.equal(capability.recoveryScope,'session-current-state')
    assert.equal(capability.persistencePreference,'preserve',
      'runtime-only Hermes Hook facts are not yet certified: do not retire Legacy')
    assert.notEqual(hermesSourceDefinition.nativeSessionCoverageComplete,true)
    const wrongTable={...second.records[0]!,locator:{
      ...second.records[0]!.locator,table:'sessions',
    }}
    assert.equal(hermesSourceDefinition.rawRecovery!.describe(wrongTable).canReread,false)
    assert.equal((await hermesSourceDefinition.rawRecovery!.verify!(wrongTable)).state,'unsupported')

    // An in-place message rewrite invalidates a previous rowid cursor, but
    // a fresh read still recovers the actual Source-owned current state.
    db.prepare('UPDATE messages SET content=? WHERE id=?')
      .run(JSON.stringify('edited current Hermes state'),'m3')
    const stale=await hermesSourceDefinition.readNativeSessionPage!({
      filePath:path,nativeSessionId:'S1',cursor:second.nextCursor,
    },ctx)
    assert.deepEqual(stale,{state:'drifted',reason:'native-database-cursor-boundary-changed'})
    const reread=await hermesSourceDefinition.readNativeSessionPage!({
      filePath:path,nativeSessionId:'S1',limit:32,
    },ctx)
    assert.equal(reread.state,'available')
    if(reread.state==='available'){
      assert.equal(reread.records.length,2)
      assert.equal(JSON.stringify(reread.records[1]?.payload)
        .includes('edited current Hermes state'),true)
    }
  }finally{db.close();await rm(root,{recursive:true,force:true})}
})

test('Hermes runtime Hook original is independently verifiable from its sealed archive',async()=>{
  const inbox=await mkdtemp(join(tmpdir(),'al-hermes-hook-verify-'))
  const oldInbox=process.env.AGENT_LENS_HERMES_INBOX
  process.env.AGENT_LENS_HERMES_INBOX=inbox
  const fileName='hook.json',nativeSessionId='S1',installationId='hermes-inst'
  const original=JSON.stringify({id:'H1',event:{session_id:nativeSessionId,
    hook_event_name:'pre_approval_request',tool_call_id:'call-1',timestamp:at}})
  const fingerprint=createHash('sha256').update(original).digest('hex')
  try{
    await writeFile(join(inbox,fileName),original)
    await archiveAcceptedHookInboxFile({inbox,fileName,nativeSessionId,installationId,
      expectedSha256:fingerprint})
    const path=archivedHookInboxRecordPath({inbox,fileName,nativeSessionId,installationId})
    const host:SourceRawRecoveryContext['host']={id:'host',name:'local',platform:process.platform,
      arch:process.arch,createdAt:at,lastSeenAt:at}
    const installation:SourceRawRecoveryContext['installation']={
      id:installationId,hostId:host.id,productId:'hermes',dataRoot:inbox,
      firstSeenAt:at,lastSeenAt:at,
    }
    const ctx:SourceRawRecoveryContext={host,installation,
      abortSignal:new AbortController().signal,
      checkpoint:{async get(){return null},async set(){throw Error('read-only')},
        async clear(){throw Error('read-only')}}}
    const record:SourceRecord={id:'H1',sourceId:'hermes',installationId,
      sourceSessionNativeId:nativeSessionId,nativeType:'hook/permission',
      capturedAt:at,locator:{kind:'runtime-hook',path,hookEventId:'H1'},fingerprint,
      payload:{},parserVersion:hermesSourceDefinition.manifest.parserVersion}
    const archived=await hermesSourceDefinition.readArchivedNativeHooks!(nativeSessionId,ctx)
    assert.equal(archived.length,1)
    assert.equal(archived[0]?.fingerprint,fingerprint)
    const normalized=await hermesSourceDefinition.normalize(archived[0]!,{host,installation})
    assert.equal(normalized.observations[0]?.kind,'permission.request')
    assert.equal(normalized.observations[0]?.nativeCallId,'call-1')
    assert.equal((await hermesSourceDefinition.rawRecovery!.verify!(archived[0]!,ctx)).state,'verified')
    assert.equal((await hermesSourceDefinition.rawRecovery!.verify!(record,ctx)).state,'verified')
    assert.equal((await hermesSourceDefinition.rawRecovery!.verify!(
      {...record,fingerprint:'0'.repeat(64)},ctx)).state,'drifted')
    assert.equal((await hermesSourceDefinition.rawRecovery!.verify!(
      {...record,sourceSessionNativeId:'OTHER'},ctx)).state,'drifted')
  }finally{
    if(oldInbox===undefined)delete process.env.AGENT_LENS_HERMES_INBOX
    else process.env.AGENT_LENS_HERMES_INBOX=oldInbox
    await rm(inbox,{recursive:true,force:true})
  }
})
