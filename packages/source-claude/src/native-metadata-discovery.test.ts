import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SourceHistoryExecutionContext } from '@agent-lens/core'
import { claudeSourceDefinition } from './index'

test('Claude code native Catalog discovers session headers without transcript event copies', async()=>{
  const root=await mkdtemp(join(tmpdir(),'al-native-claude-'))
  try{
    const project=join(root,'workspace')
    await mkdir(project,{recursive:true})
    const path=join(project,'conversation.jsonl')
    await writeFile(path,[
      JSON.stringify({type:'user',sessionId:'claude-native-1',timestamp:'2026-10-25T00:00:00Z',message:{content:'private body'}}),
      JSON.stringify({type:'assistant',sessionId:'claude-native-1',message:{content:'do not persist transcript'}}),
      '',
    ].join('\n'))
    const ctx={
      installation:{id:'claude-install',dataRoot:root},
      abortSignal:new AbortController().signal,
      historyWindow:{sessionLimit:1},
    } as unknown as SourceHistoryExecutionContext
    const indexed=[]
    for await(const entry of claudeSourceDefinition.discoverNativeSessions!(ctx))indexed.push(entry)
    assert.equal(indexed.length,1)
    assert.equal(indexed[0]?.nativeSessionId,'claude-native-1')
    assert.equal(indexed[0]?.installationId,'claude-install')
    assert.equal(indexed[0]?.filePath,path)
    assert.equal(indexed[0]?.fileSize,(await stat(path)).size)
    assert.equal(JSON.stringify(indexed).includes('private body'),false)
    assert.equal(JSON.stringify(indexed).includes('do not persist'),false)
  }finally{await rm(root,{recursive:true,force:true})}
})
