import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import type { ObservationCandidate, NativeSessionCatalogStore } from '@agent-lens/core'
import { nativeReviewObservationId } from '@agent-lens/projection-review'
import {
  handleNativeSessionAttachmentRequest,encodeNativeSessionCursor,
  type NativeSessionWindowReader,
} from './native-session-http'

test('a catalog-attested native image attachment receives an opaque on-demand media reference',async()=>{
  const sessionId='native:'+'e'.repeat(32)
  const recordId='pi-record-verified'
  const original={
    offset:120,sequence:2,fileIdentity:'1:9',
    boundaryHash:'c'.repeat(64),recordFingerprint:'b'.repeat(64),
  }
  const candidate:ObservationCandidate={
    kind:'message.user',sourceSequence:3000,
    capturedAt:'2026-11-01T00:00:00Z',
    payload:{text:'hello',attachments:[{type:'image',mimeType:'image/png'}]},
  }
  const observationId=nativeReviewObservationId(
    'pi','install','native-S',candidate,recordId,0)
  let verified=true
  let fragmentCalls=0
  const reader={
    async read(){
      return {state:'available' as const,observations:[candidate],
        observationRecordIds:[recordId],observationCursors:[original],
        evidenceCandidates:[],
        nextCursor:{offset:800,sequence:3,fileIdentity:'1:9'},
        hasMore:false,pendingTail:false}
    },
    async readTextFragments(){
      fragmentCalls++
      return {state:'available' as const,record:{
        offset:120,fileIdentity:'1:9',sourceLineSha256:verified
          ?'b'.repeat(64):'d'.repeat(64),
        recordSha256:'a'.repeat(64),role:'user',
        fragments:[],totalTextFragments:0,
        images:[{contentIndex:1,mimeType:'image/png'}],
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
      if(!await handleNativeSessionAttachmentRequest(
        req,res,new URL(req.url??'/', 'http://127.0.0.1'),reader,catalog)){
        res.statusCode=404;res.end()
      }
    }catch(error){res.statusCode=400;res.end(String(error))}
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
    const address=server.address()
    assert.ok(address&&typeof address==='object')
    const cursor=encodeNativeSessionCursor(original)
    const url=`http://127.0.0.1:${address.port}/api/v1/native-sessions/${sessionId}/observations/${observationId}/attachments?cursor=${encodeURIComponent(cursor)}`
    const response=await fetch(url)
    assert.equal(response.status,200)
    const body=await response.json() as {items:Array<{
      type:string;mimeType:string;dataUrl?:string;nativeMedia?:{
        sessionId:string;recordSha256:string;cursor:string;contentIndex:number
      }}> }
    assert.equal(body.items.length,1)
    assert.deepEqual(body.items[0]&&{
      type:body.items[0].type,mimeType:body.items[0].mimeType,
    },{type:'image',mimeType:'image/png'})
    assert.equal(body.items[0]?.nativeMedia?.sessionId,sessionId)
    assert.equal(body.items[0]?.nativeMedia?.recordSha256,'a'.repeat(64))
    assert.equal(body.items[0]?.nativeMedia?.contentIndex,1)
    assert.equal(body.items[0]?.dataUrl,undefined)
    assert.equal(JSON.stringify(body).includes('filePath'),false)
    assert.equal(JSON.stringify(body).includes('base64'),false)
    assert.equal(fragmentCalls,1)
    verified=false
    const mismatch=await (await fetch(url)).json() as {items:Array<{nativeMedia?:unknown}>}
    assert.equal(mismatch.items[0]?.nativeMedia,undefined,
      'a changed SourceRecord fingerprint cannot authorize native media')
    assert.equal(fragmentCalls,2)
    const wrong=await fetch(url.replace(observationId,'native-observation:'+'1'.repeat(32)))
    assert.equal(wrong.status,404)
    assert.equal(fragmentCalls,2)
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
