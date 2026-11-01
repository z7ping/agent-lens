import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import type { ObservationCandidate } from '@agent-lens/core'
import type { NativeReviewWindowDto } from '@agent-lens/protocol'
import { decodeNativeSessionCursor, encodeNativeSessionCursor, handleNativeSessionWindowRequest, type NativeSessionWindowReader } from './native-session-http'

const timestamp = '2026-10-29T00:00:00Z'
const fileIdentity = 'fixture:inode'
const rows = Array.from({ length: 94 }, (_, index) => ({
  kind: index === 0 || index === 91 ? 'message.user'
    : index === 31 ? 'tool.call' : index === 80 ? 'tool.result' : 'message.commentary',
  nativeCallId: index === 31 || index === 80 ? 'cross-fragment-call' : undefined,
  payload: index === 31 ? {callId:'cross-fragment-call',name:'read_file',input:{path:'README.md'}}
    : index === 80 ? {callId:'cross-fragment-call',success:true,output:'verified'}
    : {text:'record '+index},
  occurredAt: timestamp, capturedAt: timestamp,
} as ObservationCandidate))

for (const byId of [false, true]) {
  test(`原生 Review ${byId ? 'Catalog 深链接' : '来源窗口'}超页分片可续读且不丢失轮次身份`, async () => {
    let hookReads = 0
    const reader: NativeSessionWindowReader = {
      async readArchivedHooks() {
        hookReads++
        return {state:'available',observations:[],observationRecordIds:[],truncated:false}
      },
      async read(query) {
        const start = query.cursor?.offset ?? 0
        const end = Math.min(start + (query.limit ?? 8), rows.length)
        return {
          state: 'available',
          observations: rows.slice(start, end),
          observationRecordIds: rows.slice(start, end).map((_, index) => 'record-' + (start + index)),
          observationCursors: rows.slice(start, end).map((_, index) => ({
            offset: start + index, sequence: start + index, fileIdentity,
          })),
          evidenceCandidates: [],
          nextCursor: {offset:end,sequence:end,fileIdentity},
          hasMore: end < rows.length,
          pendingTail: false,
        }
      },
    }
    const reviewId = 'native:' + 'a'.repeat(32)
    const catalog = {async getByReviewSessionId(id: string) {
      return id === reviewId ? {
        sourceId:'codex',installationId:'inst',nativeSessionId:'session',
        locationKind:'native' as const,filePath:'/fixture.jsonl',fileIdentity,
        fileSize:rows.length,fileMtimeMs:0,lastActivityAt:timestamp,updatedAt:timestamp,
      } : null
    }}
    const server = createServer((request, response) => {
      void handleNativeSessionWindowRequest(
        request,response,new URL(request.url ?? '/', 'http://127.0.0.1'),reader,catalog,
      ).catch(error => { response.statusCode = 500; response.end(String(error)) })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const addr = server.address()
      assert(addr && typeof addr !== 'string')
      const base = 'http://127.0.0.1:' + addr.port + (byId
        ? '/api/v1/native-sessions/' + encodeURIComponent(reviewId) + '/review?turnLimit=4'
        : '/api/v1/native-sessions/window?sourceId=codex&installationId=inst'
          + '&nativeSessionId=session&format=review-turns&turnLimit=1')
      const firstResponse = await fetch(base)
      assert.equal(firstResponse.status, 200)
      const first = await firstResponse.json() as NativeReviewWindowDto
      assert.equal(first.state, 'available')
      assert.equal(first.pagingUnit, 'interaction')
      assert.equal(first.boundaryIntegrity, 'partial')
      assert.equal(first.turnFragment, 'partial')
      assert.equal(first.interactions.length, 1)
      assert.equal(first.interactions[0]?.ordinal, 1)
      assert.equal(hookReads, 0, '分片边界未完成时不能合并 Hook')
      if (byId) {
        assert.equal(first.hookFactsPartial, true)
        assert.equal(first.hookEventsTruncated, true)
      }
      const nextResponse = await fetch(base + '&cursor=' + encodeURIComponent(first.nextCursor))
      assert.equal(nextResponse.status, 200)
      const next = await nextResponse.json() as NativeReviewWindowDto
      assert.equal(next.state, 'available')
      assert.equal(next.pagingUnit, 'interaction')
      assert.equal(next.boundaryIntegrity, 'complete')
      assert.equal(next.turnFragment, 'complete')
      assert.equal(next.interactions.length, byId ? 2 : 1)
      assert.equal(hookReads, byId ? 1 : 0, '完整深链接窗口继续使用 Hook 合并')
      assert.equal(next.interactions[0]?.id, first.interactions[0]?.id)
      assert.equal(next.interactions[0]?.ordinal, 1)
      assert.notEqual(next.nextCursor, first.nextCursor)
      assert.equal(next.interactions[0]?.nodes.some(node => node.type === 'event'
        && node.kind === 'tool.result'), true,
        'the result must remain evidence-bearing even before client reconciliation')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
}

test('原生 Review 游标支持来源记录 SHA，但拒绝未知字段及非法校验值',()=>{
  const boundaryHash='a'.repeat(64)
  const recordFingerprint='b'.repeat(64)
  const encoded=encodeNativeSessionCursor({
    offset:123,sequence:7,fileIdentity:'host:inode',
    boundaryHash,recordFingerprint,mode:'review-turns',turnOrdinal:3,
  })
  assert.deepEqual(decodeNativeSessionCursor(encoded),{
    offset:123,sequence:7,fileIdentity:'host:inode',boundaryHash,
    recordFingerprint,mode:'review-turns',turnOrdinal:3,
  })
  for(const invalid of [
    {offset:123,sequence:7,fileIdentity:'host:inode',extra:'untrusted'},
    {offset:123,sequence:7,fileIdentity:'host:inode',recordFingerprint:'bad'},
    {offset:123,sequence:7,fileIdentity:'host:inode',turnOrdinal:3},
    {offset:123,sequence:7,fileIdentity:'host:inode',mode:'review-turns'},
  ]){
    assert.throws(()=>decodeNativeSessionCursor(
      Buffer.from(JSON.stringify(invalid)).toString('base64url')))
  }
})

test('oversized next physical record preserves verified same-turn prefix without skipping it',async()=>{
  const calls:number[]=[]
  const reader:NativeSessionWindowReader={
    async read(query){
      const offset=query.cursor?.offset??0
      calls.push(offset)
      if(offset===2)return {state:'unsupported',reason:'native-record-too-large'}
      if(offset!==0)return {state:'unsupported',reason:'unexpected-native-cursor'}
      const row:ObservationCandidate={
        kind:'message.user',sourceSequence:0,capturedAt:timestamp,
        payload:{text:'verified prompt'},
      }
      return {state:'available',observations:[row],
        observationRecordIds:['record-one'],
        observationCursors:[{offset:0,sequence:0,fileIdentity}],
        evidenceCandidates:[],
        nextCursor:{offset:2,sequence:1,fileIdentity,boundaryHash:'a'.repeat(64)},
        hasMore:true,pendingTail:false,
      }
    },
  }
  const server=createServer((request,response)=>{
    void handleNativeSessionWindowRequest(
      request,response,new URL(request.url??'/','http://127.0.0.1'),
      reader,
    ).catch(error=>{response.statusCode=500;response.end(String(error))})
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
    const addr=server.address()
    assert.ok(addr&&typeof addr==='object')
    const base=`http://127.0.0.1:${addr.port}/api/v1/native-sessions/window?sourceId=pi&installationId=inst&nativeSessionId=S&format=review-turns`
    const response=await fetch(base)
    assert.equal(response.status,200)
    const page=await response.json() as NativeReviewWindowDto
    assert.equal(page.state,'available')
    assert.equal(page.boundaryIntegrity,'partial')
    assert.equal(page.turnFragment,'partial')
    assert.equal(page.hasMore,true)
    assert.equal(page.interactions.length,1)
    assert.equal(page.interactions[0]?.nodes[0]?.type,'message')
    assert.equal(page.interactions[0]?.nodes[0]?.observationIds.length,1)
    const cursor=decodeNativeSessionCursor(page.nextCursor)
    assert.equal(cursor?.offset,2,'the original oversized SourceRecord was not skipped')
    assert.equal(cursor?.turnStart,0,'the partial turn retains its original user boundary')
    const fallback=decodeNativeSessionCursor(page.oversizedRecordSearchCursor??null)
    assert.equal(fallback?.mode,'record-fragments')
    assert.equal(fallback?.offset,2)
    assert.equal(fallback?.boundaryHash,'a'.repeat(64))
    const follow=await (await fetch(`${base}&cursor=${encodeURIComponent(page.nextCursor)}`)).json()
    assert.deepEqual(follow,{state:'unsupported',reason:'native-record-too-large'},
      'an unverified record is never rendered as a completed turn')
    assert.deepEqual(calls,[0,2,2])
  }finally{
    await new Promise<void>(resolve=>server.close(()=>resolve()))
  }
})

test('oversized following turn does not discard an earlier complete turn in a batched response',async()=>{
  const reader:NativeSessionWindowReader={
    async read(query){
      if(query.cursor?.offset===1)
        return {state:'unsupported',reason:'native-record-too-large'}
      const obs:ObservationCandidate[]=[
        {kind:'message.user',sourceSequence:0,capturedAt:timestamp,payload:{text:'first'}},
        {kind:'message.user',sourceSequence:1000,capturedAt:timestamp,payload:{text:'second'}},
      ]
      return {state:'available',observations:obs,
        observationRecordIds:['first','second'],
        observationCursors:[0,1].map(offset=>({offset,sequence:offset,fileIdentity,
          boundaryHash:'b'.repeat(64)})),
        evidenceCandidates:[],
        nextCursor:{offset:2,sequence:2,fileIdentity},
        hasMore:true,pendingTail:false,
      }
    },
  }
  const server=createServer((request,response)=>{
    void handleNativeSessionWindowRequest(request,response,
      new URL(request.url??'/','http://127.0.0.1'),reader)
      .catch(error=>{response.statusCode=500;response.end(String(error))})
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
    const addr=server.address()
    assert.ok(addr&&typeof addr==='object')
    const url=`http://127.0.0.1:${addr.port}/api/v1/native-sessions/window?sourceId=pi&installationId=inst&nativeSessionId=S&format=review-turns&turnLimit=2`
    const response=await fetch(url)
    assert.equal(response.status,200)
    const result=await response.json() as NativeReviewWindowDto
    assert.equal(result.state,'available')
    assert.equal(result.boundaryIntegrity,'complete')
    assert.equal(result.turnFragment,'complete')
    assert.deepEqual(result.interactions.map(x=>x.ordinal),[1])
    assert.equal(decodeNativeSessionCursor(result.nextCursor)?.offset,1)
    assert.equal(result.hasMore,true)
    const blocked=decodeNativeSessionCursor(result.oversizedRecordSearchCursor??null)
    assert.equal(blocked?.mode,'record-fragments')
    assert.equal(blocked?.offset,1)
    assert.equal(blocked?.boundaryHash,'b'.repeat(64))
  }finally{
    await new Promise<void>(resolve=>server.close(()=>resolve()))
  }
})

test('oversized record inside the first multi-record window retries one record and keeps the verified prefix',async()=>{
  const reads:Array<[number,number]>=[]
  const reader:NativeSessionWindowReader={
    async read(query){
      const offset=query.cursor?.offset??0
      const limit=query.limit??8
      reads.push([offset,limit])
      // The first wide read spans a small user record and one oversized line.
      if(limit>1||offset===1)return {state:'unsupported',reason:'native-record-too-large'}
      if(offset!==0)return {state:'unsupported',reason:'unexpected-cursor'}
      return {
        state:'available',observations:[{
          kind:'message.user' as const,sourceSequence:0,capturedAt:timestamp,
          payload:{text:'verified prompt'},
        }],
        observationRecordIds:['verified-user-record'],
        observationCursors:[{offset:0,sequence:0,fileIdentity,
          boundaryHash:'a'.repeat(64)}],
        evidenceCandidates:[],nextCursor:{offset:1,sequence:1,fileIdentity,
          boundaryHash:'b'.repeat(64)},
        hasMore:true,pendingTail:false,
      }
    },
  }
  const server=createServer((request,response)=>{
    void handleNativeSessionWindowRequest(request,response,
      new URL(request.url??'/','http://127.0.0.1'),reader)
      .catch(error=>{response.statusCode=500;response.end(String(error))})
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
    const addr=server.address()
    assert.ok(addr&&typeof addr==='object')
    const base=`http://127.0.0.1:${addr.port}/api/v1/native-sessions/window?sourceId=pi&installationId=inst&nativeSessionId=S&format=review-turns`
    const res=await fetch(base)
    assert.equal(res.status,200)
    const dto=await res.json() as NativeReviewWindowDto
    assert.equal(dto.state,'available')
    assert.equal(dto.turnFragment,'partial')
    assert.equal(dto.boundaryIntegrity,'partial')
    assert.equal(dto.interactions.length,1)
    assert.equal(dto.interactions[0]?.nodes[0]?.type,'message')
    assert.equal(decodeNativeSessionCursor(dto.nextCursor)?.offset,1)
    const locator=decodeNativeSessionCursor(dto.oversizedRecordSearchCursor??null)
    assert.equal(locator?.offset,1)
    assert.equal(locator?.mode,'record-fragments')
    assert.deepEqual(reads,[[0,8],[0,1],[1,1]])
  }finally{
    await new Promise<void>(resolve=>server.close(()=>resolve()))
  }
})

test('a giant record in a subsequent wide page narrows to one SourceRecord before declaring an incomplete turn',async()=>{
  const reads:Array<[number,number]>=[]
  const reader:NativeSessionWindowReader={
    async read(query){
      const offset=query.cursor?.offset??0
      const limit=query.limit??8
      reads.push([offset,limit])
      if(offset>=2 || (offset===1 && limit>1))
        return {state:'unsupported',reason:'native-record-too-large'}
      const obs:ObservationCandidate=offset===0
        ?{kind:'message.user',capturedAt:timestamp,sourceSequence:0,payload:{text:'prompt'}}
        :{kind:'message.assistant',capturedAt:timestamp,sourceSequence:1000,payload:{text:'reply'}}
      return {state:'available',observations:[obs],
        observationRecordIds:['record-'+offset],
        observationCursors:[{offset,sequence:offset,fileIdentity,
          boundaryHash:'c'.repeat(64)}],
        evidenceCandidates:[],
        nextCursor:{offset:offset+1,sequence:offset+1,fileIdentity,
          boundaryHash:'d'.repeat(64)},
        hasMore:true,pendingTail:false,
      }
    },
  }
  const server=createServer((request,response)=>{
    void handleNativeSessionWindowRequest(request,response,
      new URL(request.url??'/','http://127.0.0.1'),reader)
      .catch(error=>{response.statusCode=500;response.end(String(error))})
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
    const addr=server.address()
    assert.ok(addr&&typeof addr==='object')
    const base=`http://127.0.0.1:${addr.port}/api/v1/native-sessions/window?sourceId=pi&installationId=inst&nativeSessionId=S&format=review-turns&limit=1`
    const res=await fetch(base)
    assert.equal(res.status,200)
    const dto=await res.json() as NativeReviewWindowDto
    assert.equal(dto.turnFragment,'partial')
    assert.deepEqual(dto.interactions[0]?.nodes.filter(x=>x.type==='message').map(x=>x.role),
      ['user','assistant'])
    assert.equal(decodeNativeSessionCursor(dto.nextCursor)?.offset,2)
    assert.deepEqual(reads,[[0,1],[1,1],[2,1]])
  }finally{
    await new Promise<void>(resolve=>server.close(()=>resolve()))
  }
})
