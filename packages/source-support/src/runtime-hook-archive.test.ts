import assert from 'node:assert/strict'
import { lstat, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { archiveAcceptedHookInboxFile, readArchivedHookInboxPage, readArchivedHookInboxSession } from './runtime-hook-archive'

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
      readArchivedHookInboxPage({inbox,nativeSessionId:'S2',limit:2,cursor:first.nextCursor}),
      /Invalid archived Hook cursor/,
    )
    await assert.rejects(
      readArchivedHookInboxPage({inbox,nativeSessionId:'S1',cursor:'Li4vcGFzc3dk'}),
      /Invalid archived Hook cursor/,
    )
  }finally{await rm(inbox,{recursive:true,force:true})}
})

