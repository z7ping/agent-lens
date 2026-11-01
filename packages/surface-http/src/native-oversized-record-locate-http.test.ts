import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import type { NativeSessionCatalogStore } from '@agent-lens/core'
import type { NativeSessionWindowReader } from './native-session-http'
import { decodeNativeSessionCursor } from './native-session-http'
import { handleNativeOversizedRecordLocateRequest } from './native-oversized-record-locate-http'

test('oversized locator returns only Catalog-authorized bounded fragment cursors',async()=>{
  const id='native:'+'d'.repeat(32)
  const hash='a'.repeat(64)
  const boundaryHash='b'.repeat(64)
  let readCount=0
  const reader={
    async read(){return {state:'unsupported',reason:'not-used'}},
    async locateOversizedRecord(query:{
      sourceId:string;installationId:string;nativeSessionId:string
      cursor?:{offset:number};limit?:number
    }){
      readCount++
      assert.deepEqual([query.sourceId,query.installationId,query.nativeSessionId],
        ['pi','pi-1','pi-session'])
      if(!query.cursor){
        assert.equal(query.limit,1)
        return {state:'more' as const,nextCursor:{
          offset:100,sequence:1,fileIdentity:'1:2',boundaryHash,
        }}
      }
      assert.equal(query.cursor.offset,100)
      return {state:'found' as const,cursor:{
        offset:100,sequence:1,fileIdentity:'1:2',boundaryHash,
        recordFingerprint:'c'.repeat(64),
      },recordSha256:hash,hasText:true,nativeEventId:'user-giant'}
    },
  } as unknown as NativeSessionWindowReader
  const catalog={
    async getByReviewSessionId(sessionId:string){
      assert.equal(sessionId,id)
      return {sourceId:'pi',installationId:'pi-1',
        nativeSessionId:'pi-session',locationKind:'native'}
    },
  } as unknown as Pick<NativeSessionCatalogStore,'getByReviewSessionId'>
  const server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url??'/', 'http://127.0.0.1')
      if(!await handleNativeOversizedRecordLocateRequest(req,res,url,reader,catalog)){
        res.statusCode=404;res.end()
      }
    }catch(error){res.statusCode=400;res.end(String(error))}
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
    const addr=server.address()
    assert.ok(addr&&typeof addr==='object')
    const url=`http://127.0.0.1:${addr.port}/api/v1/native-sessions/${id}/record-fragments/locate`
    const first=await (await fetch(url+'?limit=1')).json() as
      {state:string;nextCursor?:string}
    assert.equal(first.state,'more')
    const nextCursor=decodeNativeSessionCursor(first.nextCursor??null)
    assert.equal(nextCursor?.mode,'record-fragments')
    assert.equal(nextCursor?.offset,100)
    const found=await (await fetch(`${url}?cursor=${first.nextCursor}`)).json() as
      {state:string;cursor?:string;recordSha256?:string;hasText?:boolean}
    assert.equal(found.state,'found')
    assert.equal(found.recordSha256,hash)
    assert.equal(found.hasText,true)
    const cursor=decodeNativeSessionCursor(found.cursor??null)
    assert.equal(cursor?.mode,'record-fragments')
    assert.equal(cursor?.recordFingerprint,'c'.repeat(64))
    assert.equal(JSON.stringify(found).includes('filePath'),false)
    assert.equal(readCount,2)
    assert.equal((await fetch(url+'?path=/etc/passwd')).status,400)
    assert.equal((await fetch(url+'?limit=999')).status,400)
    assert.equal(readCount,2)
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
