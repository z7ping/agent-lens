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


test('Pi fork-at validates a unique assistant native event with bounded Source Reader pagination',async()=>{
  const root=await mkdtemp(join(tmpdir(),'al-pi-native-fork-at-'))
  const filePath=join(root,'native.jsonl')
  try{
    await writeFile(filePath,JSON.stringify({type:'session',id:'s1',cwd:root})+'\n')
    const meta=await stat(filePath)
    const catalog={async getByReviewSessionId(){
      return {sourceId:'pi',installationId:'install',nativeSessionId:'s1',
        locationKind:'native',filePath,fileIdentity:`${meta.dev}:${meta.ino}`}
    }} as never
    const policy={isSourceEnabled:()=>true}
    const reads:number[]=[]
    const reader={async read(input:{limit?:number;cursor?:{offset:number}}){
      reads.push(input.limit??0)
      if(input.limit===1)return {state:'available'}
      if(!input.cursor)return {
        state:'available',pendingTail:false,hasMore:true,
        nextCursor:{offset:100,sequence:2,fileIdentity:`${meta.dev}:${meta.ino}`},
        observations:[{kind:'message.user',nativeEventId:'assistant-entry'}],
      }
      return {
        state:'available',pendingTail:false,hasMore:false,
        nextCursor:{offset:200,sequence:4,fileIdentity:`${meta.dev}:${meta.ino}`},
        observations:[{kind:'message.assistant',nativeEventId:'assistant-entry'}],
      }
    }} as never
    const resolver=createSlimPiHistoryResolver(catalog,reader,policy)
    assert.ok(resolver.resolveForkAt)
    const result=await resolver.resolveForkAt!(REVIEW,'assistant-entry')
    assert.equal(result.branchFromEntryId,'assistant-entry')
    assert.equal(result.historyAction,'fork')
    assert.equal(result.sessionPath,filePath)
    assert.deepEqual(reads,[1,32,32])
  }finally{await rm(root,{recursive:true,force:true})}
})

test('Pi fork-at rejects unverified user messages, duplicates and incomplete tail',async()=>{
  const root=await mkdtemp(join(tmpdir(),'al-pi-native-fork-deny-'))
  const filePath=join(root,'native.jsonl')
  try{
    await writeFile(filePath,JSON.stringify({type:'session',id:'s1',cwd:root})+'\n')
    const meta=await stat(filePath)
    const catalog={async getByReviewSessionId(){
      return {sourceId:'pi',installationId:'install',nativeSessionId:'s1',
        locationKind:'native',filePath,fileIdentity:`${meta.dev}:${meta.ino}`}
    }} as never
    const resolve=(observations:unknown[],pendingTail=false,hasMore=false)=>{
      const reader={async read(input:{limit?:number}){
        if(input.limit===1)return {state:'available'}
        return {state:'available',observations,pendingTail,hasMore,
          nextCursor:{offset:0,sequence:0,fileIdentity:`${meta.dev}:${meta.ino}`}}
      }} as never
      return createSlimPiHistoryResolver(catalog,reader,{isSourceEnabled:()=>true})
    }
    await assert.rejects(()=>resolve([{kind:'message.user',nativeEventId:'u'}])
      .resolveForkAt!(REVIEW,'u'),/未验证到唯一/)
    await assert.rejects(()=>resolve([
      {kind:'message.assistant',nativeEventId:'dup'},
      {kind:'message.assistant',nativeEventId:'dup'},
    ]).resolveForkAt!(REVIEW,'dup'),/不唯一/)
    await assert.rejects(()=>resolve([
      {kind:'message.assistant',nativeEventId:'tail'},
    ],true).resolveForkAt!(REVIEW,'tail'),/尾部/)
    await assert.rejects(()=>resolve([],false,true)
      .resolveForkAt!(REVIEW,'missing'),/游标无进展/)
  }finally{await rm(root,{recursive:true,force:true})}
})
