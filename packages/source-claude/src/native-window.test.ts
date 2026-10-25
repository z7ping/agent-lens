import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SourceRawRecoveryContext } from '@agent-lens/core'
import { claudeSourceDefinition } from './index'

const at = '2026-10-25T06:30:00Z'

test('Claude original JSONL pages use the existing normalizer and exact rewind cursors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-claude-native-'))
  const projects = join(root, 'projects')
  const path = join(projects, 'thread.jsonl')
  const lines = [
    JSON.stringify({ type: 'file-history-snapshot', messageId: 'meta' }),
    JSON.stringify({
      type: 'user', sessionId: 'claude-session', uuid: 'event-1', cwd: root,
      timestamp: at, message: { role: 'user', content: 'Hello from native Claude' },
    }),
    JSON.stringify({
      type: 'assistant', sessionId: 'claude-session', uuid: 'event-2',
      timestamp: at, message: { role: 'assistant', content: [{type:'text', text:'Native result'}] },
    }),
  ]
  const host: SourceRawRecoveryContext['host'] = {
    id:'host',name:'local',platform:process.platform,arch:process.arch,createdAt:at,lastSeenAt:at,
  }
  const installation: SourceRawRecoveryContext['installation'] = {
    id:'claude-install',hostId:host.id,productId:'claude-code',dataRoot:projects,configRoot:root,
    firstSeenAt:at,lastSeenAt:at,
  }
  let writes=0
  const ctx: SourceRawRecoveryContext = {
    host,installation,abortSignal:new AbortController().signal,
    checkpoint:{
      async get(){ return null },
      async set(){ writes++ },
      async clear(){ writes++ },
    },
  }
  try {
    await mkdir(projects,{recursive:true})
    await writeFile(path,lines.join('\n')+'\n')
    const read=claudeSourceDefinition.readNativeSessionPage!
    const first=await read({filePath:path,nativeSessionId:'claude-session',limit:2},ctx)
    assert.equal(first.state,'available')
    if(first.state!=='available')return
    assert.equal(first.records.length,2)
    assert.deepEqual(first.recordCursors?.map(x=>x.sequence),[0,1])
    assert.equal(first.hasMore,true)
    assert.equal(first.records[1]?.nativeId,'event-1')
    const user=await claudeSourceDefinition.normalize(first.records[1]!,{host,installation})
    assert.equal(user.observations.some(x=>x.kind==='message.user'),true)
    const second=await read({filePath:path,nativeSessionId:'claude-session',cursor:first.nextCursor},ctx)
    assert.equal(second.state,'available')
    if(second.state!=='available')return
    assert.equal(second.records[0]?.nativeId,'event-2')
    assert.equal(second.recordCursors?.[0]?.offset,first.nextCursor.offset)
    assert.equal(second.recordCursors?.[0]?.sequence,first.nextCursor.sequence)
    assert.equal(second.hasMore,false)
    assert.equal(writes,0)
    assert.deepEqual(await read({filePath:path,nativeSessionId:'other'},ctx),{
      state:'drifted',reason:'native-session-identity-changed',
    })
    const outside=join(root,'outside.jsonl')
    await writeFile(outside,lines.join('\n')+'\n')
    assert.deepEqual(await read({filePath:outside,nativeSessionId:'claude-session'},ctx),{
      state:'unsupported',reason:'source-path-not-authorized',
    })
  } finally { await rm(root,{recursive:true,force:true}) }
})

test('Claude native window rejects a mixed-session original file rather than merging identities',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-claude-mixed-'))
  const path=join(root,'mixed.jsonl')
  const host: SourceRawRecoveryContext['host']={
    id:'host',name:'local',platform:process.platform,arch:process.arch,createdAt:at,lastSeenAt:at,
  }
  const installation: SourceRawRecoveryContext['installation']={
    id:'inst',hostId:host.id,productId:'claude-code',dataRoot:root,
    firstSeenAt:at,lastSeenAt:at,
  }
  const ctx: SourceRawRecoveryContext={
    host,installation,abortSignal:new AbortController().signal,
    checkpoint:{async get(){return null},async set(){throw Error('no writes')},async clear(){throw Error('no writes')}},
  }
  try{
    await writeFile(path,[
      JSON.stringify({type:'user',sessionId:'same',message:{role:'user',content:'one'}}),
      JSON.stringify({type:'user',sessionId:'foreign',message:{role:'user',content:'two'}}),
    ].join('\n')+'\n')
    assert.deepEqual(await claudeSourceDefinition.readNativeSessionPage!({
      filePath:path,nativeSessionId:'same',
    },ctx),{state:'drifted',reason:'native-session-record-identity-changed'})
  }finally{await rm(root,{recursive:true,force:true})}
})
