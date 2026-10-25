import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SourceHistoryExecutionContext } from '@agent-lens/core'
import { codexSourceDefinition } from './index'

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
