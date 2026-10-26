import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSlimPiHistoryResolver } from './slim-pi-history'

const REVIEW='native:0123456789abcdef0123456789abcdef'

test('Slim Pi resume and fork use ONLY verified original Catalog+Reader+Pi header',async()=>{
  const root=await mkdtemp(join(tmpdir(),'al-pi-native-history-'))
  const sessionPath=join(root,'session.jsonl')
  try{
    await writeFile(sessionPath,JSON.stringify({
      type:'session',id:'session-id',cwd:root,
    })+'\n')
    const file=await stat(sessionPath)
    let readCalls=0
    const resolver=createSlimPiHistoryResolver({
      async getByReviewSessionId(id:string){
        assert.equal(id,REVIEW)
        return {
          sourceId:'pi',installationId:'pi-install',nativeSessionId:'session-id',
          locationKind:'native' as const, filePath:sessionPath,
          fileIdentity:`${file.dev}:${file.ino}`,fileSize:file.size,
          fileMtimeMs:file.mtimeMs,lastActivityAt:new Date().toISOString(),
          updatedAt:new Date().toISOString(),
        }
      },
    } as never,{
      async read(input:{sourceId:string;nativeSessionId:string;limit?:number}){
        readCalls++
        assert.equal(input.sourceId,'pi')
        assert.equal(input.nativeSessionId,'session-id')
        assert.equal(input.limit,1)
        return {state:'available'}
      },
    } as never,{isSourceEnabled:()=>true})
    const resumed=await resolver.resolve(REVIEW,'continue')
    assert.equal(resumed.sessionPath,sessionPath)
    assert.equal(resumed.cwd,root)
    assert.equal(resumed.historyAction,'continue')
    assert.equal(resumed.logicalSessionId,REVIEW)
    assert.equal((await resolver.resolve(REVIEW,'fork')).historyAction,'fork')
    assert.equal(readCalls,2)
  }finally{await rm(root,{recursive:true,force:true})}
})

test('Slim Pi denies disabled Source, drifted Reader and wrong native session header',async()=>{
  const root=await mkdtemp(join(tmpdir(),'al-pi-native-deny-'))
  const sessionPath=join(root,'session.jsonl')
  try{
    await writeFile(sessionPath,JSON.stringify({
      type:'session',id:'different',cwd:root,
    })+'\n')
    const file=await stat(sessionPath)
    let lookedUp=0
    const catalog={
      async getByReviewSessionId(){
        lookedUp++
        return {
          sourceId:'pi',installationId:'install',nativeSessionId:'expected',
          locationKind:'native',filePath:sessionPath,
          fileIdentity:`${file.dev}:${file.ino}`,
        }
      },
    } as never
    const disabled=createSlimPiHistoryResolver(catalog,{} as never,{
      isSourceEnabled:()=>false,
    })
    await assert.rejects(()=>disabled.resolve(REVIEW,'continue'),/已禁用/)
    assert.equal(lookedUp,0)
    const drifted=createSlimPiHistoryResolver(catalog,{
      read:async()=>({state:'drifted',reason:'file-inode-changed'}),
    } as never,{isSourceEnabled:()=>true})
    await assert.rejects(()=>drifted.resolve(REVIEW,'continue'),/file-inode-changed/)
    const mismatched=createSlimPiHistoryResolver(catalog,{
      read:async()=>({state:'available'}),
    } as never,{isSourceEnabled:()=>true})
    await assert.rejects(()=>mismatched.resolve(REVIEW,'fork'),/不一致/)
    await assert.rejects(()=>mismatched.resolve('legacy-logical-id','continue'),/无效/)
  }finally{await rm(root,{recursive:true,force:true})}
})
