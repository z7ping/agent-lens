import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import type { NativeSessionCatalogStore } from '@agent-lens/core'
import type { NativeSessionWindowReader } from './native-session-http'
import { encodeNativeSessionCursor } from './native-session-http'
import { handleNativeRecordFragmentsRequest } from './native-record-fragments-http'

test('record fragment route uses Catalog identity, never accepts paths, and returns sanitized fragment-only DTO',async()=>{
  const sessionId='native:'+'f'.repeat(32)
  const sha='a'.repeat(64)
  const cursor=encodeNativeSessionCursor({
    offset:120,sequence:2,fileIdentity:'device:inode',
    recordFingerprint:'b'.repeat(64),
    mode:'review-turns',turnOrdinal:1,
  })
  let calls=0
  const reader={
    async read(){return {state:'unsupported' as const,reason:'unused'}},
    async readTextFragments(query:{
      sourceId:string;installationId:string;nativeSessionId:string
      cursor:{offset:number};fragmentOffset?:number;expectedSha256?:string
    }){
      calls++
      assert.deepEqual([
        query.sourceId,query.installationId,query.nativeSessionId,query.cursor.offset,
      ],['pi','install','native-S',120])
      assert.equal(query.fragmentOffset,query.expectedSha256?1:0)
      return {state:'available' as const,record:{
        offset:120,fileIdentity:'device:inode',recordSha256:sha,
        nativeEventId:'native-user',role:'user',
        fragments:[{ordinal:0,text:'[已脱敏]',kind:'thinking',contentIndex:3,redactionApplied:true}],
        totalTextFragments:2,nextFragmentOffset:1,
      }}
    },
  } as unknown as NativeSessionWindowReader
  const catalog={
    async getByReviewSessionId(id:string){
      assert.equal(id,sessionId)
      return {sourceId:'pi',installationId:'install',
        nativeSessionId:'native-S',locationKind:'native'}
    },
  } as unknown as Pick<NativeSessionCatalogStore,'getByReviewSessionId'>
  const server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url??'/', 'http://127.0.0.1')
      if(!await handleNativeRecordFragmentsRequest(req,res,url,reader,catalog)){
        res.statusCode=404;res.end()
      }
    }catch(error){res.statusCode=400;res.end(error instanceof Error?error.message:'invalid')}
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
    const address=server.address()
    assert.ok(address&&typeof address==='object')
    const base=`http://127.0.0.1:${address.port}/api/v1/native-sessions/${encodeURIComponent(sessionId)}/record-fragments`
    const valid=await fetch(`${base}?cursor=${cursor}`)
    assert.equal(valid.status,200)
    const result=await valid.json() as Record<string,unknown>
    assert.equal(result.state,'available')
    assert.equal(result.coverage,'fragment-only')
    assert.equal(result.sessionId,sessionId)
    assert.equal(result.recordSha256,sha)
    assert.deepEqual(result.fragments,[{ordinal:0,text:'[已脱敏]',kind:'thinking',contentIndex:3,redactionApplied:true}])
    assert.equal(result.nextFragmentOffset,1)
    assert.equal(JSON.stringify(result).includes('fileIdentity'),false)
    assert.equal(JSON.stringify(result).includes('filePath'),false)
    assert.equal(calls,1)
    assert.equal((await fetch(`${base}?cursor=${cursor}&path=/etc/passwd`)).status,400)
    assert.equal((await fetch(`${base}?cursor=${cursor}&fragmentOffset=1`)).status,400)
    assert.equal(calls,1,'invalid selectors are rejected before invoking Source')
    assert.equal((await fetch(`${base}?cursor=${cursor}&fragmentOffset=1&expectedSha256=${sha}`)).status,200)
    assert.equal(calls,2)
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()))}
})

test('media route requires verified Catalog cursor, original SHA and bounded image selector',async()=>{
  const id='native:'+'b'.repeat(32)
  const sha='a'.repeat(64)
  const cursor=encodeNativeSessionCursor({
    offset:10,sequence:1,fileIdentity:'9:1',
    boundaryHash:'c'.repeat(64),recordFingerprint:'d'.repeat(64),
    mode:'record-fragments',
  })
  let called=0
  const reader={
    async read(){return {state:'unsupported' as const,reason:'unused'}},
    async readTextFragments(q:{
      sourceId:string;cursor:{offset:number}
      media?:{contentIndex:number;offset:number;limit:number}
      expectedSha256?:string
    }){
      called++
      assert.equal(q.sourceId,'pi')
      assert.equal(q.cursor.offset,10)
      assert.equal(q.expectedSha256,sha)
      assert.deepEqual(q.media,{contentIndex:2,offset:0,limit:128*1024})
      return {state:'available' as const,record:{
        offset:10,fileIdentity:'9:1',recordSha256:sha,
        fragments:[],totalTextFragments:0,
        images:[{contentIndex:2,mimeType:'image/png'}],
        media:{contentIndex:2,mimeType:'image/png',
          base64:'AQID',totalBase64Length:4},
      }}
    },
  } as unknown as NativeSessionWindowReader
  const catalog={
    async getByReviewSessionId(){return {
      sourceId:'pi',installationId:'pi-i',nativeSessionId:'session-i',locationKind:'native',
    }},
  } as unknown as Pick<NativeSessionCatalogStore,'getByReviewSessionId'>
  const server=createServer(async(req,res)=>{
    try{
      if(!await handleNativeRecordFragmentsRequest(req,res,
        new URL(req.url??'/', 'http://127.0.0.1'),reader,catalog)){
        res.statusCode=404;res.end()
      }
    }catch(error){res.statusCode=400;res.end(String(error))}
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
    const address=server.address()
    assert.ok(address&&typeof address==='object')
    const url=`http://127.0.0.1:${address.port}/api/v1/native-sessions/${id}/record-fragments/media`
    const query=`cursor=${cursor}&expectedSha256=${sha}&imageIndex=2`
    const valid=await fetch(`${url}?${query}`)
    assert.equal(valid.status,200)
    const page=await valid.json() as Record<string,unknown>
    assert.equal(page.coverage,'media-chunk-only')
    assert.equal(page.base64,'AQID')
    assert.equal(page.mimeType,'image/png')
    assert.equal(JSON.stringify(page).includes('fileIdentity'),false)
    assert.equal(JSON.stringify(page).includes('filePath'),false)
    assert.equal(called,1)
    assert.equal((await fetch(`${url}?cursor=${cursor}&imageIndex=2`)).status,400)
    assert.equal((await fetch(`${url}?${query}&mediaOffset=3`)).status,400)
    assert.equal((await fetch(`${url}?${query}&mediaLimit=262144`)).status,400)
    assert.equal(called,1)
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
