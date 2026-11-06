import assert from 'node:assert/strict'
import test from 'node:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  CapturePolicyService, NativeSessionCatalogEntry, NativeSessionCatalogStore,
  ObservationCandidate, SourceNativeSessionCursor,
} from '@agent-lens/core'
import type { NativeBodySearchResponseDto } from '@agent-lens/protocol'
import { handleNativeSessionBodySearchRequest } from './native-session-search-http'
import type { NativeSessionWindowReader } from './native-session-http'

const at='2026-11-06T00:00:00.000Z'
const entry:NativeSessionCatalogEntry={
  sourceId:'pi',installationId:'installation',nativeSessionId:'session',
  locationKind:'native',filePath:'/tmp/pi-session.jsonl',
  fileIdentity:'file-1',fileSize:900,fileMtimeMs:100,
  lastActivityAt:at,updatedAt:at,
}
const hit=(kind:string,id:string,value:string):ObservationCandidate=>({
  kind:kind as ObservationCandidate['kind'],
  nativeEventId:id,capturedAt:at,occurredAt:at,
  payload:{text:value},identityHints:{},
})
const fp=(n:number)=>n.toString(16).padStart(64,'0')
const cursor=(n:number):SourceNativeSessionCursor=>({
  offset:n,sequence:n,fileIdentity:'file-1',recordFingerprint:fp(n),
})
const catalog={
  async query(){return {items:[entry],hasMore:false}}
} as unknown as Pick<NativeSessionCatalogStore,'query'>
const policy={
  isSourceEnabled(sourceId:string){return sourceId==='pi'}
} as unknown as CapturePolicyService

async function search(reader:NativeSessionWindowReader, next?:string){
  let body=''
  const response={
    statusCode:200,writableEnded:false,destroyed:false,
    setHeader(){return this},
    once(){return this},
    off(){return this},
    end(content:string){body=content;this.writableEnded=true;return this},
  } as unknown as ServerResponse
  const request={method:'GET'} as IncomingMessage
  const params=new URLSearchParams({q:'needle',sourceId:'pi'})
  if(next)params.set('cursor',next)
  const url=new URL('http://localhost/api/v1/native-sessions/search?'+params.toString())
  const handled=await handleNativeSessionBodySearchRequest(request,response,url,catalog,reader,policy)
  assert.equal(handled,true)
  assert.equal(response.statusCode,200)
  return JSON.parse(body) as NativeBodySearchResponseDto
}

test('native search retains exact observation IDs and user turn boundaries across Source pages',async()=>{
  const reader:NativeSessionWindowReader={
    async read(query){
      const offset=query.cursor?.offset??0
      const observations=offset===0
        ? [hit('message.user','u1','first needle question'),
          hit('tool.result','t1','needle tool result')]
        : [hit('message.assistant','a1','needle answer'),
          hit('message.user','u2','second needle question')]
      return {
        state:'available',observations,
        observationRecordIds:observations.map((_,i)=>'rec-'+(offset+i)),
        observationCursors:observations.map((_,i)=>cursor(offset+i)),
        evidenceCandidates:[],nextCursor:cursor(offset+2),
        hasMore:offset===0,pendingTail:false,
      }
    },
  }
  const first=await search(reader)
  assert.equal(first.state,'available')
  if(first.state!=='available')return
  assert.deepEqual(first.items.map(item=>item.turn?.ordinal),[1,1])
  assert.equal(first.items[1]?.turn?.nativeEventId,'u1')
  assert.equal(first.items[1]?.turn?.recordOffset,0)
  assert.equal(first.items[1]?.turn?.recordFingerprint,fp(0))
  assert.equal(first.items[1]?.observationId===first.items[0]?.observationId,false)
  assert.equal(first.hasMore,true)
  assert.ok(first.nextCursor)
  const second=await search(reader,first.nextCursor)
  assert.equal(second.state,'available')
  if(second.state!=='available')return
  assert.deepEqual(second.items.map(item=>item.turn?.ordinal),[1,2])
  assert.equal(second.items[0]?.turn?.nativeEventId,'u1')
  assert.equal(second.items[1]?.turn?.nativeEventId,'u2')
  assert.equal(second.hasMore,false)
})

test('Source search degrades to plain matches when native record boundaries are absent',async()=>{
  const reader:NativeSessionWindowReader={
    async read(){
      return {
        state:'available',
        observations:[hit('message.user','u1','needle')],
        observationRecordIds:['rec-0'],
        evidenceCandidates:[],nextCursor:cursor(1),
        hasMore:false,pendingTail:false,
      }
    },
  }
  const page=await search(reader)
  assert.equal(page.state,'available')
  if(page.state!=='available')return
  assert.equal(page.items.length,1)
  assert.equal(page.items[0]?.turn,undefined)
  assert.ok(page.items[0]?.observationId)
})
