import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SourceHistoryExecutionContext } from '@agent-lens/core'
import { codexSourceDefinition } from './index'
import { readSessionActivity } from './history'

test('Codex enumerates active and archived native JSONL using header only',async()=>{
  const root=await mkdtemp(join(tmpdir(),'al-native-codex-'))
  try{
    const active=join(root,'sessions')
    const archive=join(root,'archived_sessions')
    await mkdir(active,{recursive:true})
    await mkdir(archive,{recursive:true})
    const path=join(active,'session.jsonl')
    const archived=join(archive,'archived.jsonl')
    await writeFile(path,JSON.stringify({type:'session_meta',payload:{id:'codex-live',cwd:active}})+'\n'+JSON.stringify({type:'response_item',payload:{text:'never indexed message body'}})+'\n')
    await writeFile(archived,JSON.stringify({type:'session_meta',payload:{id:'codex-archived'}})+'\n')
    const ctx={
      installation:{id:'codex-install',configRoot:root,dataRoot:active},
      abortSignal:new AbortController().signal,
    } as unknown as SourceHistoryExecutionContext
    const entries=[]
    for await(const item of codexSourceDefinition.discoverNativeSessions!(ctx)) entries.push(item)
    assert.deepEqual(new Set(entries.map(x=>x.nativeSessionId)),new Set(['codex-live','codex-archived']))
    assert.equal(entries.every(x=>x.locationKind==='native'),true)
    assert.equal(entries.find(x=>x.nativeSessionId==='codex-live')?.fileSize,(await stat(path)).size)
    assert.equal(JSON.stringify(entries).includes('never indexed'),false)
  }finally{await rm(root,{recursive:true,force:true})}
})

test('Codex 原生目录复用标题索引，文件复制时间不覆盖原生活动时间',async()=>{
  const root=await mkdtemp(join(tmpdir(),'al-native-codex-title-'))
  try{
    const active=join(root,'sessions');await mkdir(active)
    const path=join(active,'session.jsonl')
    await writeFile(path,JSON.stringify({type:'session_meta',payload:{id:'old',timestamp:'2026-07-01T00:00:00Z'}})+'\n')
    await utimes(path,new Date(),new Date())
    await writeFile(join(root,'session_index.jsonl'),[
      {id:'old',thread_name:'原生标题',updated_at:'2026-07-02T00:00:00Z'},
      {id:'old',thread_name:'过期标题',updated_at:'2026-07-01T00:00:00Z'},
    ].map(x=>JSON.stringify(x)).join('\n'))
    const context={installation:{id:'i',configRoot:root,dataRoot:active},
      abortSignal:new AbortController().signal} as unknown as SourceHistoryExecutionContext
    const entries=[]
    for await(const entry of codexSourceDefinition.discoverNativeSessions!(context))entries.push(entry)
    assert.equal(entries[0]?.title,'原生标题')
    assert.equal(entries[0]?.lastActivityAt,'2026-07-02T00:00:00.000Z')
    await rm(join(root,'session_index.jsonl'))
    for await(const entry of codexSourceDefinition.discoverNativeSessions!(context)){
      assert.equal(entry.lastActivityAt,'2026-07-01T00:00:00.000Z')
    }
  }finally{await rm(root,{recursive:true,force:true})}
})


test('Codex 有界尾部时间优先于旧索引，截断行与无时间内容不污染活动时间',async()=>{
  const root=await mkdtemp(join(tmpdir(),'al-native-codex-time-'))
  try{
    const path=join(root,'session.jsonl')
    await writeFile(path,JSON.stringify({timestamp:'2026-07-03T00:00:00Z',type:'response_item'})+'\n'+JSON.stringify({content:'x'.repeat(70000)})+'\n'+JSON.stringify({timestamp:'2026-07-04T00:00:00Z'})+'\n'+ '{"timestamp":"2026-10-27')
    assert.equal(await readSessionActivity(path,'2026-07-02T00:00:00.000Z'),'2026-07-04T00:00:00.000Z')
    assert.equal(await readSessionActivity(path,'2026-07-05T00:00:00.000Z'),'2026-07-05T00:00:00.000Z')
  }finally{await rm(root,{recursive:true,force:true})}
})
