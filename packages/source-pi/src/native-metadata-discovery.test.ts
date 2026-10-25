import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SourceHistoryExecutionContext } from '@agent-lens/core'
import { piSourceDefinition } from './index'

test('Pi discovers native files from headers and metadata, not transcript replay',async()=>{
  const root=await mkdtemp(join(tmpdir(),'al-native-pi-'))
  try{
    const sub=join(root,'project')
    await mkdir(sub,{recursive:true})
    const path=join(sub,'fixture.jsonl')
    await writeFile(path, [
      JSON.stringify({type:'session',id:'pi-session-1',cwd:sub}),
      JSON.stringify({type:'message',message:{role:'user',content:'private content never indexed'}}),
      '',
    ].join('\n'))
    const ctx={
      installation:{id:'pi-install',dataRoot:root},
      abortSignal:new AbortController().signal,
      historyWindow:{sessionLimit:1},
    } as unknown as SourceHistoryExecutionContext
    const rows=[]
    for await (const item of piSourceDefinition.discoverNativeSessions!(ctx)) rows.push(item)
    assert.equal(rows.length,1)
    assert.equal(rows[0]?.nativeSessionId,'pi-session-1')
    assert.equal(rows[0]?.installationId,'pi-install')
    assert.equal(rows[0]?.filePath,path)
    assert.equal(rows[0]?.locationKind,'native')
    assert.equal(rows[0]?.fileSize,(await import('node:fs/promises')).stat(path).then(x=>x.size) instanceof Promise, false)
    assert.equal(JSON.stringify(rows).includes('private content'),false)
  }finally{ await rm(root,{recursive:true,force:true}) }
})
