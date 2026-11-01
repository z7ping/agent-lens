import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentLensApi } from './api'
import { loadNativeImagePreview } from './native-media-preview'

const ref={
  sessionId:'native:'+'f'.repeat(32),cursor:'opaque-verified-cursor',
  recordSha256:'a'.repeat(64),contentIndex:2,mimeType:'image/png',
}
type MediaReader=Pick<AgentLensApi,'nativeRecordMediaChunk'>

test('native image preview reuses SHA-bound media chunks and rejects inconsistent pages',async()=>{
  const offsets:number[]=[]
  const api={
    async nativeRecordMediaChunk(sessionId:string,query:{mediaOffset:number}){
      assert.equal(sessionId,ref.sessionId)
      offsets.push(query.mediaOffset)
      return {state:'available' as const,coverage:'media-chunk-only' as const,
        sessionId:ref.sessionId,recordSha256:ref.recordSha256,
        contentIndex:ref.contentIndex,mimeType:ref.mimeType,
        base64:query.mediaOffset===0?'QUJD':'REVG',
        totalBase64Length:8,
        ...(query.mediaOffset===0?{nextOffset:4}:{})}
    },
  } as MediaReader
  assert.equal(await loadNativeImagePreview(api,ref),'data:image/png;base64,QUJDREVG')
  assert.deepEqual(offsets,[0,4])
  const bad={
    async nativeRecordMediaChunk(){
      return {state:'available' as const,coverage:'media-chunk-only' as const,
        sessionId:ref.sessionId,recordSha256:'b'.repeat(64),
        contentIndex:ref.contentIndex,mimeType:'image/png',
        base64:'QUJD',totalBase64Length:4}
    },
  } as MediaReader
  await assert.rejects(loadNativeImagePreview(bad,ref),/native-media-evidence-mismatch/)
})

test('native image preview rejects forged references, excessive sizes and abort',async()=>{
  const never={async nativeRecordMediaChunk(){throw new Error('should not read')}} as MediaReader
  await assert.rejects(loadNativeImagePreview(never,{...ref,cursor:''}),
    /native-media-reference-invalid/)
  const excess={
    async nativeRecordMediaChunk(){
      return {state:'available' as const,coverage:'media-chunk-only' as const,
        sessionId:ref.sessionId,recordSha256:ref.recordSha256,
        contentIndex:ref.contentIndex,mimeType:ref.mimeType,
        base64:'QUJD',totalBase64Length:8*1024*1024+4,
        nextOffset:4}
    },
  } as MediaReader
  await assert.rejects(loadNativeImagePreview(excess,ref),/native-media-evidence-mismatch/)
  const controller=new AbortController()
  controller.abort()
  await assert.rejects(loadNativeImagePreview(never,ref,controller.signal),/abort/i)
})
