import assert from 'node:assert/strict'
import { lstat, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { archiveAcceptedHookInboxFile, archivedHookInboxRecordPath, nativeHookArchiveEnabled, readArchivedHookInboxPage, readArchivedHookInboxSession } from './runtime-hook-archive'

test('archive accepted source Hook by hard link: original is single-copy and session-scoped',async()=>{
  const inbox=await mkdtemp(join(tmpdir(),'al-native-hook-'))
  try {
    const fileName='hook-1.json'
    const original=JSON.stringify({id:'H1',event:{type:'PreToolUse',session_id:'session-1',private:'secret'}})
    await writeFile(join(inbox,fileName),original)
    const old=await stat(join(inbox,fileName))
    await archiveAcceptedHookInboxFile({inbox,fileName,nativeSessionId:'session-1'})
    await assert.rejects(lstat(join(inbox,fileName)),{code:'ENOENT'})
    assert.deepEqual(await readArchivedHookInboxSession({inbox,nativeSessionId:'session-1'}),[
      {fileName,content:original},
    ])
    const hashArchive=(await import('node:fs/promises')).readdir(join(inbox,'archive'))
    const [sessionDir]=await hashArchive
    assert.notEqual(sessionDir,'session-1','session name must not be leaked in filesystem path')
    const archived=await stat(join(inbox,'archive',sessionDir!,fileName))
    assert.equal(archived.ino,old.ino,'archive must retain same inode, not copy event content')
    assert.equal((await readArchivedHookInboxSession({inbox,nativeSessionId:'other-session'})).length,0)
  }finally{await rm(inbox,{recursive:true,force:true})}
})

test('sidecar retries accept equal original but never overwrite colliding Hook payload',async()=>{
  const inbox=await mkdtemp(join(tmpdir(),'al-native-hook-collision-'))
  try{
    const fileName='event.json'
    await writeFile(join(inbox,fileName),'{"id":"first"}')
    await archiveAcceptedHookInboxFile({inbox,fileName,nativeSessionId:'S1'})
    await writeFile(join(inbox,fileName),'{"id":"first"}')
    await archiveAcceptedHookInboxFile({inbox,fileName,nativeSessionId:'S1'})
    await writeFile(join(inbox,fileName),'{"id":"second"}')
    await assert.rejects(
      archiveAcceptedHookInboxFile({inbox,fileName,nativeSessionId:'S1'}),
      /collision/)
    assert.equal(await readFile(join(inbox,fileName),'utf8'),'{"id":"second"}')
    assert.equal((await readArchivedHookInboxSession({inbox,nativeSessionId:'S1'}))[0]?.content,'{"id":"first"}')
  }finally{await rm(inbox,{recursive:true,force:true})}
})

test('sidecar rejects source filename traversal and unbounded event bodies',async()=>{
  const inbox=await mkdtemp(join(tmpdir(),'al-native-hook-guard-'))
  try{
    await assert.rejects(
      archiveAcceptedHookInboxFile({inbox,fileName:'../secret.json',nativeSessionId:'S1'}),
      /Invalid original Hook/)
    await writeFile(join(inbox,'too-large.json'),'x'.repeat(1024*1024+1))
    await assert.rejects(
      archiveAcceptedHookInboxFile({inbox,fileName:'too-large.json',nativeSessionId:'S1'}),
      /bounded regular file/)
    assert.equal((await readArchivedHookInboxSession({inbox,nativeSessionId:'S1'})).length,0)
    await assert.rejects(readArchivedHookInboxSession({inbox,nativeSessionId:'S1',limit:1000}),/out of range/)
  }finally{await rm(inbox,{recursive:true,force:true})}
})

test('Hook sidecar pages preserve every source file, reject cross-session cursor and path injection',async()=>{
  const inbox=await mkdtemp(join(tmpdir(),'al-native-hook-page-'))
  try{
    for(let index=0;index<5;index++){
      const fileName=`event-${index}.json`
      await writeFile(join(inbox,fileName),JSON.stringify({id:index,event:{session_id:'S1'}}))
      await archiveAcceptedHookInboxFile({inbox,fileName,nativeSessionId:'S1'})
    }
    const first=await readArchivedHookInboxPage({inbox,nativeSessionId:'S1',limit:2})
    assert.deepEqual(first.items.map(item=>item.fileName),['event-0.json','event-1.json'])
    assert.equal(first.hasMore,true)
    assert.ok(first.nextCursor)
    assert.equal(first.nextCursor.includes(inbox),false)
    const second=await readArchivedHookInboxPage({
      inbox,nativeSessionId:'S1',limit:2,cursor:first.nextCursor!,
    })
    assert.deepEqual(second.items.map(item=>item.fileName),['event-2.json','event-3.json'])
    assert.equal(second.hasMore,true)
    const third=await readArchivedHookInboxPage({
      inbox,nativeSessionId:'S1',limit:2,cursor:second.nextCursor!,
    })
    assert.deepEqual(third.items.map(item=>item.fileName),['event-4.json'])
    assert.equal(third.hasMore,false)
    assert.equal(third.nextCursor,undefined)
    await assert.rejects(
      readArchivedHookInboxPage({inbox,nativeSessionId:'S2',limit:2,cursor:first.nextCursor!}),
      /Invalid archived Hook cursor/,
    )
    await assert.rejects(
      readArchivedHookInboxPage({inbox,nativeSessionId:'S1',cursor:'Li4vcGFzc3dk'}),
      /Invalid archived Hook cursor/,
    )
  }finally{await rm(inbox,{recursive:true,force:true})}
})

test('Hook archive scope separates installations even for identical native session ID and filename',async()=>{
  const inbox=await mkdtemp(join(tmpdir(),'al-native-installation-scope-'))
  try{
    const session='same-native-session'
    const fileName='hook-1.json'
    const firstContent=JSON.stringify({id:'one',event:{session_id:session,token:'first-install'}})
    const secondContent=JSON.stringify({id:'two',event:{session_id:session,token:'second-install'}})
    await writeFile(join(inbox,fileName),firstContent)
    const before=await stat(join(inbox,fileName))
    await archiveAcceptedHookInboxFile({
      inbox,fileName,nativeSessionId:session,installationId:'installation-A',
    })
    const aPath=archivedHookInboxRecordPath({
      inbox,fileName,nativeSessionId:session,installationId:'installation-A',
    })
    assert.equal((await stat(aPath)).ino,before.ino)
    await writeFile(join(inbox,fileName),secondContent)
    await archiveAcceptedHookInboxFile({
      inbox,fileName,nativeSessionId:session,installationId:'installation-B',
    })
    const bPath=archivedHookInboxRecordPath({
      inbox,fileName,nativeSessionId:session,installationId:'installation-B',
    })
    assert.notEqual(aPath,bPath)
    const a=await readArchivedHookInboxPage({
      inbox,nativeSessionId:session,installationId:'installation-A',
    })
    const b=await readArchivedHookInboxPage({
      inbox,nativeSessionId:session,installationId:'installation-B',
    })
    assert.equal(a.items[0]?.content,firstContent)
    assert.equal(b.items[0]?.content,secondContent)
    assert.equal(a.hasMore,false)
    assert.equal(b.hasMore,false)
    assert.deepEqual((await readArchivedHookInboxSession({inbox,nativeSessionId:session})),[],
      'unscoped legacy reader must not acquire v2 installation-scoped events')
    // Continuations are scoped to BOTH installation and native session.
    await writeFile(join(inbox,'hook-2.json'),JSON.stringify({id:'three'}))
    await archiveAcceptedHookInboxFile({
      inbox,fileName:'hook-2.json',nativeSessionId:session,installationId:'installation-A',
    })
    const first=await readArchivedHookInboxPage({
      inbox,nativeSessionId:session,installationId:'installation-A',limit:1,
    })
    assert.ok(first.nextCursor)
    await assert.rejects(readArchivedHookInboxPage({
      inbox,nativeSessionId:session,installationId:'installation-B',
      cursor:first.nextCursor!,
    }),/Invalid archived Hook cursor/)
  }finally{await rm(inbox,{recursive:true,force:true})}
})



test('source-owned Hook archive defaults to enabled with explicit emergency opt-out', () => {
  assert.equal(nativeHookArchiveEnabled({} as NodeJS.ProcessEnv), true)
  assert.equal(nativeHookArchiveEnabled({ AGENT_LENS_NATIVE_HOOK_ARCHIVE: '1' } as NodeJS.ProcessEnv), true)
  assert.equal(nativeHookArchiveEnabled({ AGENT_LENS_NATIVE_HOOK_ARCHIVE: '0' } as NodeJS.ProcessEnv), false)
  assert.equal(nativeHookArchiveEnabled({ AGENT_LENS_NATIVE_HOOK_ARCHIVE: '' } as NodeJS.ProcessEnv), true)
})

test('Hook archive cursor detects newly inserted older-sort files instead of losing them',async()=>{
  const inbox=await mkdtemp(join(tmpdir(),'al-hook-snapshot-'))
  const session='stable-session'
  const installationId='worker-install'
  try {
    for(const name of ['b.json','d.json','f.json']){
      await writeFile(join(inbox,name),JSON.stringify({id:name}))
      await archiveAcceptedHookInboxFile({inbox,fileName:name,nativeSessionId:session,installationId})
    }
    const first=await readArchivedHookInboxPage({inbox,nativeSessionId:session,installationId,limit:1})
    assert.deepEqual(first.items.map(item=>item.fileName),['b.json'])
    assert.equal(first.hasMore,true)
    assert.ok(first.nextCursor)
    assert.equal(first.nextCursor!.length<=512,true)
    assert.equal(first.nextCursor!.includes('b.json'),false)
    await writeFile(join(inbox,'a.json'),JSON.stringify({id:'a'}))
    await archiveAcceptedHookInboxFile({inbox,fileName:'a.json',nativeSessionId:session,installationId})
    await assert.rejects(readArchivedHookInboxPage({
      inbox,nativeSessionId:session,installationId,limit:1,cursor:first.nextCursor!,
    }),/Invalid archived Hook cursor/,'resume must fail rather than skip a newly inserted earlier event')

    let cursor: string | undefined
    const all: string[]=[]
    for(let page=0;page<8;page++){
      const result=await readArchivedHookInboxPage({
        inbox,nativeSessionId:session,installationId,limit:1,
        ...(cursor ? {cursor} : {}),
      })
      all.push(...result.items.map(item=>item.fileName))
      if(!result.hasMore)break
      assert.ok(result.nextCursor)
      cursor=result.nextCursor
    }
    assert.deepEqual(all,['a.json','b.json','d.json','f.json'])
  } finally {
    await rm(inbox,{recursive:true,force:true})
  }
})

test('Hook archive cursor remains opaque and bounded for long valid inbox names',async()=>{
  const inbox=await mkdtemp(join(tmpdir(),'al-hook-long-cursor-'))
  const session='long-name-session'
  const installationId='install'
  try {
    const longName='a'.repeat(200)+'.json'
    for(const fileName of [longName,'z.json']){
      await writeFile(join(inbox,fileName),JSON.stringify({fileName}))
      await archiveAcceptedHookInboxFile({inbox,fileName,nativeSessionId:session,installationId})
    }
    const page=await readArchivedHookInboxPage({inbox,nativeSessionId:session,installationId,limit:1})
    assert.ok(page.nextCursor)
    assert.ok(page.nextCursor!.length <=512)
    assert.ok(!page.nextCursor!.includes(longName))
    const second=await readArchivedHookInboxPage({
      inbox,nativeSessionId:session,installationId,limit:1,cursor:page.nextCursor!,
    })
    assert.deepEqual(second.items.map(x=>x.fileName),['z.json'])
  }finally{await rm(inbox,{recursive:true,force:true})}
})

