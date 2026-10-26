import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSlimCodexHistoryResolver } from './slim-codex-history'

const id='native:0123456789abcdef0123456789abcdef'

test('Codex uses verified session_meta and original Source identity to resume',async()=>{
  const root=await mkdtemp(join(tmpdir(),'al-slim-codex-history-'))
  try{
    const filePath=join(root,'rollout.jsonl')
    await writeFile(filePath,JSON.stringify({
      timestamp:'2026-10-26T00:00:00Z',type:'session_meta',
      payload:{id:'thread-original',cwd:root},
    })+'\n')
    const info=await stat(filePath)
    const catalog={async getByReviewSessionId(key:string){
      assert.equal(key,id)
      return {sourceId:'codex',installationId:'install',nativeSessionId:'thread-original',
        locationKind:'native',filePath,fileIdentity:`${info.dev}:${info.ino}`}
    }} as never
    let reads=0
    const reader={async read(input:{sourceId:string;nativeSessionId:string;limit?:number}){
      reads++
      assert.equal(input.sourceId,'codex')
      assert.equal(input.nativeSessionId,'thread-original')
      assert.equal(input.limit,1)
      return {state:'available'}
    }} as never
    const resolver=createSlimCodexHistoryResolver(catalog,reader,{
      isSourceEnabled:()=>true,
    })
    const resumed=await resolver.resolve(id)
    assert.deepEqual(resumed,{threadId:'thread-original',cwd:root})
    assert.equal(reads,1)
  }finally{await rm(root,{recursive:true,force:true})}
})

test('Codex rejects disabled, drifted and conflicting original session headers',async()=>{
  const root=await mkdtemp(join(tmpdir(),'al-slim-codex-fail-'))
  try{
    const filePath=join(root,'rollout.jsonl')
    await writeFile(filePath,JSON.stringify({
      type:'session_meta',payload:{id:'other-thread',cwd:root},
    })+'\n')
    const info=await stat(filePath)
    let hits=0
    const catalog={async getByReviewSessionId(){
      hits++
      return {sourceId:'codex',installationId:'install',nativeSessionId:'expected',
        locationKind:'native',filePath,fileIdentity:`${info.dev}:${info.ino}`}
    }} as never
    const disabled=createSlimCodexHistoryResolver(catalog,{} as never,{
      isSourceEnabled:()=>false,
    })
    await assert.rejects(()=>disabled.resolve(id),/已禁用/)
    assert.equal(hits,0)
    const drifted=createSlimCodexHistoryResolver(catalog,{
      read:async()=>({state:'drifted',reason:'native-inode-changed'}),
    } as never,{isSourceEnabled:()=>true})
    await assert.rejects(()=>drifted.resolve(id),/native-inode-changed/)
    const untrusted=createSlimCodexHistoryResolver(catalog,{
      read:async()=>({state:'available'}),
    } as never,{isSourceEnabled:()=>true})
    await assert.rejects(()=>untrusted.resolve(id),/ID 不匹配/)
    await assert.rejects(()=>untrusted.resolve('legacy-session-1'),/仅接受/)
  }finally{await rm(root,{recursive:true,force:true})}
})
