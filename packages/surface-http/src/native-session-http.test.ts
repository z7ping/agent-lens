import assert from 'node:assert/strict'
import test from 'node:test'
import type { StorageService, NativeSessionCatalogEntry } from '@agent-lens/core'
import { nativeReviewSessionId } from '@agent-lens/projection-review'
import type { NativeSessionWindowReader } from './native-session-http'
import { encodeNativeSessionCursor } from './native-session-http'
import { startHttpSurface } from './server'

const noopStorage = { health: async () => ({ ok: true }) } as unknown as StorageService

test('native session HTTP reads via identities only, supports opaque cursor and omits raw Evidence locators', async () => {
  const calls: Array<Record<string, unknown>> = []
  const reader: NativeSessionWindowReader = {
    async read(query) {
      calls.push({
        sourceId: query.sourceId,
        installationId: query.installationId,
        nativeSessionId: query.nativeSessionId,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        limit: query.limit,
        hasAbortSignal: typeof query.signal?.addEventListener === 'function',
      })
      const followup = query.cursor?.offset === 128 && calls.length === 3
      return {
        state: 'available',
        observations: [{
          kind: followup ? 'message.assistant' : 'message.user',
          capturedAt: '2026-10-25T00:00:00Z',
          identityHints: { nativeSessionId: 'session 1' },
          payload: { text: '[redacted]' },
        }],
        observationRecordIds: [followup ? 'record-2' : 'record-1'],
        evidenceCandidates: [{
          captureMethod: 'native-log',
          derivation: 'observed',
          capturedAt: '2026-10-25T00:00:00Z',
          sourceLocator: { kind: 'file', path: '/sensitive/work/secret.jsonl' },
        }],
        nextCursor: { offset: followup ? 256 : 128, sequence: followup ? 2 : 1, fileIdentity: '1:2' },
        hasMore: !followup,
        pendingTail: false,
      }
    },
  }
  const server = await startHttpSurface(noopStorage, { port: 0, nativeSessionReader: reader })
  const endpoint = `http://${server.host}:${server.port}/api/v1/native-sessions/window`
  try {
    const first = await fetch(`${endpoint}?sourceId=pi&installationId=inst&nativeSessionId=session%201`)
    assert.equal(first.status, 200)
    const body = await first.json() as {
      state: string; observations: Array<{payload:{text:string}}>;
      nextCursor: string; hasMore: boolean; pendingTail: boolean
    }
    assert.equal(body.state, 'available')
    assert.equal(body.observations[0]?.payload.text, '[redacted]')
    assert.equal(body.hasMore, true)
    assert.equal(body.pendingTail, false)
    assert.equal(JSON.stringify(body).includes('/sensitive/work'), false)
    assert.equal(JSON.stringify(body).includes('evidenceCandidates'), false)

    const review = await fetch(`${endpoint}?sourceId=pi&installationId=inst&nativeSessionId=session%201&format=review`)
    assert.equal(review.status, 200)
    const rendered = await review.json() as {
      state: string; boundaryIntegrity: string;
      interactions: Array<{nodes: Array<{type:string; text?:string}>}>
    }
    assert.equal(rendered.state, 'available')
    assert.equal(rendered.boundaryIntegrity, 'complete')
    assert.equal(rendered.interactions[0]?.nodes[0]?.type, 'message')
    assert.equal(rendered.interactions[0]?.nodes[0]?.text, '[redacted]')
    assert.equal(rendered.interactions[0]?.nodes[1]?.type, 'message')
    assert.equal(JSON.stringify(rendered).includes('/sensitive/work'), false)

    const second = await fetch(`${endpoint}?sourceId=pi&installationId=inst&nativeSessionId=session%201&limit=2&cursor=${body.nextCursor}`)
    assert.equal(second.status, 200)
    assert.deepEqual(calls, [{
      sourceId: 'pi', installationId: 'inst', nativeSessionId: 'session 1', limit: 8, hasAbortSignal: true,
    }, {
      sourceId: 'pi', installationId: 'inst', nativeSessionId: 'session 1', limit: 8, hasAbortSignal: true,
    }, {
      sourceId: 'pi', installationId: 'inst', nativeSessionId: 'session 1', limit: 8,
      cursor: { offset: 128, sequence: 1, fileIdentity: '1:2' }, hasAbortSignal: true,
    }, {
      sourceId: 'pi', installationId: 'inst', nativeSessionId: 'session 1', limit: 2,
      cursor: { offset: 128, sequence: 1, fileIdentity: '1:2' }, hasAbortSignal: true,
    }])
  } finally {
    await server.dispose()
  }
})


test('native Review pairs tool calls/results across source windows without leaking Evidence', async () => {
  let reads = 0
  const at = '2026-10-25T00:00:00Z'
  const native = (kind: 'message.user' | 'tool.call' | 'tool.result', sourceSequence: number, payload: object) => ({
    kind, sourceSequence, capturedAt: at, payload,
    identityHints: { nativeSessionId: 'S1' },
  })
  const reader: NativeSessionWindowReader = {
    async read(query) {
      reads++
      const first = query.cursor === undefined
      return {
        state: 'available',
        observations: first ? [
          native('message.user', 1000, {text:'run'}),
          native('tool.call', 2000, {callId:'one',nativeToolName:'shell',input:{command:'test'}}),
        ] : [
          native('tool.result', 3000, {callId:'one',success:true,output:'done'}),
        ],
        observationRecordIds: first ? ['r1', 'r2'] : ['r3'],
        // This must not be emitted as a raw file locator in the Review DTO.
        evidenceCandidates: [{
          captureMethod: 'native-log', derivation: 'observed', capturedAt: at,
          sourceLocator: {kind:'file',path:'/sensitive/private.jsonl'},
        }],
        nextCursor: {offset: first ? 256 : 512,sequence: first ? 2 : 3,fileIdentity:'1:2'},
        hasMore: first, pendingTail: false,
      }
    },
  }
  const surface = await startHttpSurface(noopStorage, {port:0,nativeSessionReader:reader})
  const base = `http://${surface.host}:${surface.port}/api/v1/native-sessions/window?sourceId=pi&installationId=inst&nativeSessionId=S1`
  try {
    const response = await fetch(`${base}&format=review`)
    assert.equal(response.status, 200)
    const body = await response.json() as {
      boundaryIntegrity: string; observationCount:number; hasMore:boolean; nextCursor:string;
      interactions:Array<{nodes:Array<{type:string;status?:string;output?:string;observationIds:string[]}>}>
    }
    assert.equal(reads, 2)
    assert.equal(body.boundaryIntegrity, 'complete')
    assert.equal(body.observationCount, 3)
    assert.equal(body.hasMore, false)
    assert.equal(body.interactions.length, 1)
    const tool = body.interactions[0]?.nodes.find(n=>n.type==='tool')
    assert.equal(tool?.status, 'success')
    assert.equal(tool?.output, 'done')
    assert.equal(tool?.observationIds.length, 2)
    assert.equal(JSON.stringify(body).includes('/sensitive/'), false)
    // A client jumping in at the second byte window does not have the call.
    const single = await fetch(`${base}&format=review&cursor=${encodeNativeSessionCursor({
      offset:256,sequence:2,fileIdentity:'1:2',
    })}`)
    const partial = await single.json() as {boundaryIntegrity:string;interactions:Array<{nodes:Array<{type:string}>}>}
    assert.equal(partial.boundaryIntegrity, 'partial')
    assert.equal(partial.interactions[0]?.nodes[0]?.type, 'event')
  } finally {
    await surface.dispose()
  }
})

test('native Review stops on bounded read budget, stalled cursor and identity drift', async () => {
  const baseReader = (mode:'long'|'stalled'|'drift'): NativeSessionWindowReader => ({
    async read(query) {
      const n = (query.cursor?.sequence ?? 0) + 1
      return {
        state:'available',
        observations:[{
          kind:'message.user',capturedAt:'2026-10-25T00:00:00Z',
          identityHints:{nativeSessionId:'S1'},payload:{text:'page '+n},
        }],
        observationRecordIds:['r'+n], evidenceCandidates:[],
        nextCursor:{
          offset: mode==='stalled' ? 0 : n*128,
          sequence:n,
          fileIdentity: mode==='drift' && n===2 ? '3:4' : '1:2',
        },
        hasMore: mode==='long' || (mode==='stalled' && n===1) || (mode==='drift' && n===1),
        pendingTail:false,
      }
    },
  })
  for (const [mode, expected] of [
    ['long','partial'], ['stalled','native-review-cursor-not-advancing'],
    ['drift','native-review-file-identity-changed'],
  ] as const) {
    const surface=await startHttpSurface(noopStorage,{port:0,nativeSessionReader:baseReader(mode)})
    try {
      const response=await fetch(`http://${surface.host}:${surface.port}/api/v1/native-sessions/window?sourceId=pi&installationId=inst&nativeSessionId=S1&format=review`)
      const body=await response.json() as {boundaryIntegrity?:string;reason?:string;observationCount?:number}
      assert.equal(response.status,200)
      assert.equal(body.reason ?? body.boundaryIntegrity,expected)
      if(mode==='long') assert.equal(body.observationCount,8)
    } finally {
      await surface.dispose()
    }
  }
})

test('native session HTTP fails closed for paths, malformed cursors, oversized pages and wrong verbs', async () => {
  let readCount = 0
  const reader: NativeSessionWindowReader = {
    async read() {
      readCount++
      return { state: 'unavailable', reason: 'native-file-missing' }
    },
  }
  const surface = await startHttpSurface(noopStorage, { port: 0, nativeSessionReader: reader })
  const endpoint = `http://${surface.host}:${surface.port}/api/v1/native-sessions/window`
  const base = `${endpoint}?sourceId=pi&installationId=inst&nativeSessionId=S1`
  try {
    const requests = [
      `${base}&path=%2Fprivate%2Fsecret.jsonl`,
      `${base}&filePath=%2Fprivate%2Fsecret.jsonl`,
      `${base}&limit=65`,
      `${base}&limit=1&limit=2`,
      `${base}&cursor=illegal`,
      `${base}&format=unknown`,
      `${base}&format=review&format=review`,
      `${base}&cursor=${encodeNativeSessionCursor({ offset: -1, sequence: 0, fileIdentity: '1:2' })}`,
      `${base}&cursor=${encodeNativeSessionCursor({ offset: 0.5, sequence: 0, fileIdentity: '1:2' })}`,
      `${base}&cursor=${encodeNativeSessionCursor({ offset: 0, sequence: 0, fileIdentity: '' })}`,
      `${endpoint}?sourceId=pi&installationId=inst`,
      `${endpoint}?sourceId=pi&sourceId=codex&installationId=inst&nativeSessionId=S1`,
    ]
    for (const url of requests) {
      const response = await fetch(url)
      assert.equal(response.status, 400, url)
    }
    assert.equal(readCount, 0)
    const post = await fetch(base, { method: 'POST' })
    assert.equal(post.status, 405)
    assert.equal(post.headers.get('allow'), 'GET')
    const valid = await fetch(base)
    assert.equal(valid.status, 200)
    assert.deepEqual(await valid.json(), { state: 'unavailable', reason: 'native-file-missing' })
    assert.equal(readCount, 1)
  } finally {
    await surface.dispose()
  }

  const unavailable = await startHttpSurface(noopStorage, { port: 0 })
  try {
    const response = await fetch(`http://${unavailable.host}:${unavailable.port}/api/v1/native-sessions/window`)
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(),
      { state: 'unavailable', reason: 'native-session-reader-unavailable' })
  } finally {
    await unavailable.dispose()
  }
})

test('native session HTTP bounds serialized payloads even when normalization is large', async () => {
  const reader: NativeSessionWindowReader = {
    async read() {
      return {
        state: 'available',
        observations: [{
          kind: 'message.assistant',
          capturedAt: '2026-10-25T00:00:00Z',
          identityHints: { nativeSessionId: 'S1' },
          payload: { text: 'x'.repeat(5 * 1024 * 1024) },
        }],
        observationRecordIds: ['record-large'],
        evidenceCandidates: [],
        nextCursor: { offset: 100, sequence: 1, fileIdentity: '1:2' },
        hasMore: false, pendingTail: false,
      }
    },
  }
  const surface = await startHttpSurface(noopStorage, { port: 0, nativeSessionReader: reader })
  try {
    const response = await fetch(`http://${surface.host}:${surface.port}/api/v1/native-sessions/window?sourceId=pi&installationId=inst&nativeSessionId=S1`)
    assert.equal(response.status, 413)
    assert.deepEqual(await response.json(), { state: 'unsupported', reason: 'native-window-response-too-large' })
  } finally {
    await surface.dispose()
  }
})


test('native complete-turn pagination never skips a user boundary and keeps global ordinals', async () => {
  const at = '2026-10-25T00:00:00Z'
  const rows = [
    {kind:'session.lifecycle',payload:{event:'session.started'}},
    {kind:'message.user',payload:{text:'first'}},
    {kind:'tool.call',payload:{callId:'tool-1',nativeToolName:'shell'}},
    {kind:'tool.result',payload:{callId:'tool-1',success:true,output:'ok'}},
    {kind:'message.assistant',payload:{text:'completed first'}},
    {kind:'message.user',payload:{text:'second'}},
    {kind:'message.assistant',payload:{text:'completed second'}},
  ] as const
  const calls: number[] = []
  const reader: NativeSessionWindowReader = {
    async read(query) {
      const start = query.cursor?.offset ?? 0
      calls.push(start)
      const current = rows.slice(start/64, start/64+2)
      const nextOffset = start+current.length*64
      return {
        state:'available', observations:current.map((row,index)=>({
          kind: row.kind, capturedAt:at, sourceSequence: start/64 + index,
          identityHints:{nativeSessionId:'S1'},payload:row.payload,
        })),
        observationRecordIds:current.map((_,index)=>'r'+(start/64+index)),
        observationCursors:current.map((_,index)=>({
          offset:start+index*64,sequence:start/64+index,fileIdentity:'1:2',
        })),
        evidenceCandidates:[],nextCursor:{offset:nextOffset,sequence:nextOffset/64,fileIdentity:'1:2'},
        hasMore:nextOffset<rows.length*64,pendingTail:false,
      }
    },
  }
  const surface=await startHttpSurface(noopStorage,{port:0,nativeSessionReader:reader})
  const base=`http://${surface.host}:${surface.port}/api/v1/native-sessions/window?sourceId=pi&installationId=inst&nativeSessionId=S1&format=review-turns`
  try {
    const first=await fetch(base)
    assert.equal(first.status,200)
    const one=await first.json() as {
      state:string;pagingUnit:string;boundaryIntegrity:string;hasMore:boolean;nextCursor:string;
      interactions:Array<{ordinal:number;nodes:Array<{type:string;text?:string;status?:string;observationIds:string[]}>}>
    }
    assert.equal(one.state,'available')
    assert.equal(one.pagingUnit,'interaction')
    assert.equal(one.boundaryIntegrity,'complete')
    assert.equal(one.hasMore,true)
    assert.equal(one.interactions.length,1)
    assert.equal(one.interactions[0]?.ordinal,1)
    const tool=one.interactions[0]?.nodes.find(node=>node.type==='tool')
    assert.equal(tool?.status,'success')
    assert.equal(tool?.observationIds.length,2)
    assert.equal(one.interactions[0]?.nodes.find(node=>node.text==='second'),undefined)
    const nextCursor=JSON.parse(Buffer.from(one.nextCursor,'base64url').toString('utf8')) as {
      offset:number;sequence:number;turnOrdinal:number;mode:string
    }
    assert.deepEqual(nextCursor,{offset:320,sequence:5,fileIdentity:'1:2',mode:'review-turns',turnOrdinal:2})
    const second=await fetch(`${base}&cursor=${one.nextCursor}`)
    const two=await second.json() as typeof one
    assert.equal(second.status,200)
    assert.equal(two.boundaryIntegrity,'complete')
    assert.equal(two.hasMore,false)
    assert.equal(two.interactions.length,1)
    assert.equal(two.interactions[0]?.ordinal,2)
    assert.equal(two.interactions[0]?.nodes.find(node=>node.text==='second')?.type,'message')
    assert.equal(two.interactions[0]?.nodes.find(node=>node.text==='first'),undefined)
    assert.deepEqual(calls,[0,128,256,320])
  } finally { await surface.dispose() }
})

test('complete-turn cursor refuses mismatched mode and an arbitrary mid-turn offset', async () => {
  const reader: NativeSessionWindowReader = { async read(query) {
    const start=query.cursor?.offset ?? 0
    return {
      state:'available',
      observations:[{kind: start===0?'message.user' as const:'tool.result' as const,
        capturedAt:'2026-10-25T00:00:00Z',payload:{text:'test'},identityHints:{nativeSessionId:'S1'}}],
      observationRecordIds:['r'+start],
      observationCursors:[{offset:start,sequence:start/64,fileIdentity:'1:2'}],
      evidenceCandidates:[],nextCursor:{offset:start+64,sequence:start/64+1,fileIdentity:'1:2'},
      hasMore:false,pendingTail:false,
    }
  }}
  const surface=await startHttpSurface(noopStorage,{port:0,nativeSessionReader:reader})
  const base=`http://${surface.host}:${surface.port}/api/v1/native-sessions/window?sourceId=pi&installationId=inst&nativeSessionId=S1`
  try {
    const rawCursor=encodeNativeSessionCursor({offset:64,sequence:1,fileIdentity:'1:2'})
    const turnCursor=encodeNativeSessionCursor({
      offset:64,sequence:1,fileIdentity:'1:2',mode:'review-turns',turnOrdinal:2,
    })
    assert.equal((await fetch(`${base}&format=review-turns&cursor=${rawCursor}`)).status,400)
    assert.equal((await fetch(`${base}&format=review&cursor=${turnCursor}`)).status,400)
    const invalid=await fetch(`${base}&format=review-turns&cursor=${turnCursor}`)
    assert.equal(invalid.status,200)
    assert.deepEqual(await invalid.json(),{
      state:'unsupported',reason:'native-review-cursor-not-turn-boundary',
    })
  } finally { await surface.dispose() }
})

test('complete-turn reader fails closed on pending tool across users and excessive turn length', async () => {
  for (const mode of ['pending-tool','budget','tail','missing-rewind'] as const) {
    let calls=0
    const reader: NativeSessionWindowReader={async read(query){
      calls++
      const n=query.cursor?.sequence ?? 0
      const isSecond=mode==='pending-tool' && n>0
      const kind=isSecond?'message.user' as const:n===0?'message.user' as const:'tool.call' as const
      const observation={
        kind:mode==='pending-tool' && n===0?'tool.call' as const:kind,
        capturedAt:'2026-10-25T00:00:00Z',
        identityHints:{nativeSessionId:'S1'},
        payload:{callId:'open-tool',text:'data'},
      }
      const offset=n*64
      const observations = mode==='pending-tool' && n===0
        ? [{ ...observation, kind:'message.user' as const }, observation]
        : [observation]
      return {
        state:'available', observations, observationRecordIds:observations.map((_,i)=>'r'+n+'-'+i),
        ...(mode==='missing-rewind'?{}:{
          observationCursors: observations.map(()=>({offset,sequence:n,fileIdentity:'1:2'})),
        }),
        evidenceCandidates:[],
        nextCursor:{offset:offset+64,sequence:n+1,fileIdentity:'1:2'},
        hasMore:mode==='budget'||(mode==='pending-tool'&&n===0),
        pendingTail:mode==='tail',
      }
    }}
    const surface=await startHttpSurface(noopStorage,{port:0,nativeSessionReader:reader})
    try {
      const response=await fetch(`http://${surface.host}:${surface.port}/api/v1/native-sessions/window?sourceId=pi&installationId=inst&nativeSessionId=S1&format=review-turns`)
      assert.equal(response.status,200)
      const payload=await response.json() as {state:string;reason?:string;interactions?:unknown[]}
      assert.equal(payload.state,'unsupported')
      assert.equal(payload.reason,({
        'pending-tool':'native-review-cross-turn-tool-pending',
        budget:'native-review-turn-exceeds-budget',
        tail:'native-review-turn-pending-tail',
        'missing-rewind':'native-review-record-boundaries-unavailable',
      })[mode])
      assert.equal(payload.interactions,undefined)
      if(mode==='budget') assert.equal(calls,8)
    } finally { await surface.dispose() }
  }
})

test('native complete-turn at EOF never certifies unresolved tool calls or metadata-only sessions', async () => {
  for (const mode of ['unresolved-tool', 'no-user', 'empty-records'] as const) {
    const reader: NativeSessionWindowReader = {
      async read() {
        const at = '2026-10-25T00:00:00Z'
        const observed = mode === 'empty-records' ? [] : mode === 'no-user'
          ? [{kind: 'session.lifecycle' as const, capturedAt: at,
            identityHints: {nativeSessionId: 'S1'}, payload: {event: 'session.started'}}]
          : [
            {kind: 'message.user' as const, capturedAt: at,
              identityHints: {nativeSessionId: 'S1'}, payload: {text: 'run tool'}},
            {kind: 'tool.call' as const, capturedAt: at,
              identityHints: {nativeSessionId: 'S1'}, payload: {callId: 'pending', nativeToolName: 'shell'}},
          ]
        return {
          state: 'available' as const,
          observations: observed,
          observationRecordIds: observed.map((_, i) => `row-${i}`),
          observationCursors: observed.map((_, i) => ({
            offset: i * 64, sequence: i, fileIdentity: '1:2',
          })),
          evidenceCandidates: [],
          nextCursor: {offset: Math.max(1, observed.length) * 64,
            sequence: Math.max(1, observed.length), fileIdentity: '1:2'},
          hasMore: false, pendingTail: false,
        }
      },
    }
    const surface = await startHttpSurface(noopStorage, {port: 0, nativeSessionReader: reader})
    try {
      const url = `http://${surface.host}:${surface.port}/api/v1/native-sessions/window?sourceId=pi&installationId=inst&nativeSessionId=S1&format=review-turns`
      const result = await fetch(url)
      assert.equal(result.status, 200)
      assert.deepEqual(await result.json(), {
        state: 'unsupported',
        reason: mode === 'unresolved-tool' ? 'native-review-turn-tool-pending' : 'native-review-no-user-turn',
      })
    } finally {
      await surface.dispose()
    }
  }
})

test('native Review batching returns contiguous complete turns with one rewind cursor',async()=>{
  const at='2026-10-25T00:00:00Z'
  const records=[
    {kind:'message.user' as const,payload:{text:'first'}},
    {kind:'message.assistant' as const,payload:{text:'reply-one'}},
    {kind:'message.user' as const,payload:{text:'second'}},
    {kind:'tool.call' as const,payload:{callId:'t2',nativeToolName:'shell'}},
    {kind:'tool.result' as const,payload:{callId:'t2',success:true}},
    {kind:'message.assistant' as const,payload:{text:'reply-two'}},
    {kind:'message.user' as const,payload:{text:'third'}},
    {kind:'message.assistant' as const,payload:{text:'reply-three'}},
  ]
  let pages=0
  const reader:NativeSessionWindowReader={
    async read(query){
      pages++
      const start=query.cursor?.offset??0
      const from=start/64
      const selected=records.slice(from,from+2)
      const nextOffset=start+selected.length*64
      return {
        state:'available',observations:selected.map((row,i)=>({
          ...row,capturedAt:at,identityHints:{nativeSessionId:'S1'},sourceSequence:from+i,
        })),
        observationRecordIds:selected.map((_,i)=>'record-'+(from+i)),
        observationCursors:selected.map((_,i)=>({
          offset:start+i*64,sequence:from+i,fileIdentity:'native-file',
        })),
        evidenceCandidates:[],nextCursor:{
          offset:nextOffset,sequence:nextOffset/64,fileIdentity:'native-file',
        },
        hasMore:nextOffset<records.length*64,pendingTail:false,
      }
    },
  }
  const http=await startHttpSurface(noopStorage,{port:0,nativeSessionReader:reader})
  const url=`http://${http.host}:${http.port}/api/v1/native-sessions/window?sourceId=pi&installationId=inst&nativeSessionId=S1&format=review-turns`
  try{
    const first=await fetch(url+'&turnLimit=2')
    assert.equal(first.status,200)
    const two=await first.json() as {
      state:string;pagingUnit:string;boundaryIntegrity:string;observationCount:number;
      interactions:Array<{ordinal:number;nodes:Array<{type:string;text?:string;status?:string}>}>;
      nextCursor:string;hasMore:boolean;
    }
    assert.equal(two.state,'available')
    assert.equal(two.pagingUnit,'interaction')
    assert.equal(two.boundaryIntegrity,'complete')
    assert.deepEqual(two.interactions.map(x=>x.ordinal),[1,2])
    assert.equal(two.interactions[1]?.nodes.find(x=>x.type==='tool')?.status,'success')
    assert.equal(two.observationCount,6)
    assert.equal(two.hasMore,true)
    const rewind=JSON.parse(Buffer.from(two.nextCursor,'base64url').toString('utf8')) as {
      offset:number;turnOrdinal:number
    }
    assert.equal(rewind.offset,384)
    assert.equal(rewind.turnOrdinal,3)
    const third=await fetch(url+'&turnLimit=2&cursor='+encodeURIComponent(two.nextCursor))
    assert.equal(third.status,200)
    const last=await third.json() as typeof two
    assert.deepEqual(last.interactions.map(x=>x.ordinal),[3])
    assert.equal(last.interactions[0]?.nodes.find(x=>x.text==='reply-three')?.type,'message')
    assert.equal(last.hasMore,false)
    assert.ok(pages<=16)
    for(const suffix of ['&turnLimit=0','&turnLimit=5','&turnLimit=abc','&turnLimit=1&turnLimit=2']){
      const invalid=await fetch(url+suffix)
      assert.equal(invalid.status,400,suffix)
    }
    const invalidFormat=await fetch(url.replace('&format=review-turns','&format=review')+'&turnLimit=2')
    assert.equal(invalidFormat.status,400)
  }finally{await http.dispose()}
})

test('native Review stable-ID endpoint resolves Catalog on demand without accepting caller-owned source paths',async()=>{
  const at='2026-10-25T00:00:00Z'
  const entry:NativeSessionCatalogEntry={
    sourceId:'pi',installationId:'inst',nativeSessionId:'S1',
    locationKind:'native',filePath:'/private/should-not-expose.jsonl',
    fileIdentity:'1:2',fileSize:128,fileMtimeMs:1,lastActivityAt:at,updatedAt:at,
  }
  const nativeId=nativeReviewSessionId(entry.sourceId,entry.installationId,entry.nativeSessionId)
  let catalogReads=0
  const storage={
    ...noopStorage,
    nativeSessionCatalog:{
      async getByReviewSessionId(value:string){
        catalogReads++
        return value===nativeId?entry:null
      },
    },
  } as unknown as StorageService
  const called:Array<{sourceId:string;installationId:string;nativeSessionId:string}>=[]
  const reader:NativeSessionWindowReader={
    async read(q){
      called.push({sourceId:q.sourceId,installationId:q.installationId,nativeSessionId:q.nativeSessionId})
      return {
        state:'available',
        observations:[{
          kind:'message.user',capturedAt:at,
          payload:{text:'hello'},identityHints:{nativeSessionId:'S1'},
        }],
        observationRecordIds:['native-row-1'],
        observationCursors:[{offset:0,sequence:0,fileIdentity:'1:2'}],
        evidenceCandidates:[],
        nextCursor:{offset:64,sequence:1,fileIdentity:'1:2'},
        hasMore:false,pendingTail:false,
      }
    },
  }
  const server=await startHttpSurface(storage,{port:0,nativeSessionReader:reader})
  const url=`http://${server.host}:${server.port}/api/v1/native-sessions/${encodeURIComponent(nativeId)}/review`
  try{
    const response=await fetch(url+'?turnLimit=2')
    assert.equal(response.status,200)
    const payload=await response.json() as {state:string;sessionId:string;interactions:Array<{ordinal:number}>}
    assert.equal(payload.state,'available')
    assert.equal(payload.sessionId,nativeId)
    assert.deepEqual(payload.interactions.map(item=>item.ordinal),[1])
    assert.equal(JSON.stringify(payload).includes('/private/'),false)
    assert.deepEqual(called,[{sourceId:'pi',installationId:'inst',nativeSessionId:'S1'}])
    assert.equal(catalogReads,1)
    for (const suffix of ['?sourceId=codex','?nativeSessionId=OTHER','?path=/tmp/x','?format=review']) {
      assert.equal((await fetch(url+suffix)).status,400,suffix)
    }
    const missingUrl = url.replace(encodeURIComponent(nativeId), encodeURIComponent(nativeReviewSessionId('pi','inst','missing')))
    assert.equal((await fetch(missingUrl)).status,404)
  }finally{await server.dispose()}
})

test('native Review lazy images resolve from source cursor, never SQL rows or arbitrary paths',async()=>{
  const at='2026-10-25T00:00:00Z'
  const entry:NativeSessionCatalogEntry={
    sourceId:'pi',installationId:'pi-inst',nativeSessionId:'S-image',
    locationKind:'native',filePath:'/source-owned/never-exposed.jsonl',
    fileIdentity:'8:2',fileSize:200,fileMtimeMs:1000,
    lastActivityAt:at,updatedAt:at,
  }
  const id=nativeReviewSessionId(entry.sourceId,entry.installationId,entry.nativeSessionId)
  const storage={
    ...noopStorage,
    nativeSessionCatalog:{
      async getByReviewSessionId(value:string){return value===id?entry:null},
    },
  } as unknown as StorageService
  const cursor={offset:0,sequence:0,fileIdentity:'8:2'}
  const user={
    kind:'message.user' as const,capturedAt:at,
    payload:{text:'What is this?',attachments:[{
      kind:'images',value:{type:'image',mimeType:'image/png',data:'aGVsbG8='},
    }]},
    identityHints:{nativeSessionId:'S-image'},
  }
  let reads=0
  const reader:NativeSessionWindowReader={
    async read(q){
      reads++
      assert.equal(q.sourceId,'pi')
      assert.equal(q.nativeSessionId,'S-image')
      if(q.cursor)assert.deepEqual(q.cursor,cursor)
      return {
        state:'available',observations:[user],
        observationRecordIds:['source-record-id'],
        observationCursors:[cursor],
        evidenceCandidates:[{
          captureMethod:'native-log',derivation:'observed',capturedAt:at,
          sourceLocator:{kind:'file',path:'/sensitive/image-source-private.jsonl'},
        }],
        nextCursor:{offset:100,sequence:1,fileIdentity:'8:2'},
        hasMore:false,pendingTail:false,
      }
    },
  }
  const server=await startHttpSurface(storage,{port:0,nativeSessionReader:reader})
  try{
    const base=`http://${server.host}:${server.port}/api/v1/native-sessions/${id}`
    const reviewResponse=await fetch(base+'/review')
    assert.equal(reviewResponse.status,200)
    const review=await reviewResponse.json() as {
      interactions:Array<{nodes:Array<{type:string;id:string;nativeAttachmentCursor?:string;attachments?:unknown[]}>}>
    }
    const message=review.interactions[0]?.nodes.find(n=>n.type==='message')
    assert.ok(message?.nativeAttachmentCursor)
    assert.equal(JSON.stringify(review).includes('aGVsbG8='),false)
    const attachmentPath=`${base}/observations/${message.id}/attachments?cursor=${encodeURIComponent(message.nativeAttachmentCursor!)}`
    const response=await fetch(attachmentPath)
    assert.equal(response.status,200)
    const body=await response.json() as {items:Array<{type:string;mimeType?:string;dataUrl?:string}>}
    assert.deepEqual(body.items,[{type:'image',mimeType:'image/png',dataUrl:'data:image/png;base64,aGVsbG8='}])
    assert.equal(JSON.stringify(body).includes('/sensitive/'),false)
    assert.equal((await fetch(`${base}/observations/native-observation:${'0'.repeat(32)}/attachments?cursor=${encodeURIComponent(message.nativeAttachmentCursor!)}`)).status,404)
    assert.equal((await fetch(`${base}/observations/${message.id}/attachments?cursor=${encodeURIComponent(message.nativeAttachmentCursor!)}&path=/etc/passwd`)).status,400)
    assert.equal(reads,3)
  }finally{await server.dispose()}
})

test('native Hook endpoint is metadata-authorized, returns partial Review nodes without Source paths',async()=>{
  const at='2026-10-25T00:00:00Z'
  const entry:NativeSessionCatalogEntry={
    sourceId:'codex',installationId:'codex-inst',nativeSessionId:'S-hook',
    locationKind:'native',filePath:'/private/session.jsonl',
    fileIdentity:'2:3',fileSize:1024,fileMtimeMs:1000,lastActivityAt:at,updatedAt:at,
  }
  const nativeId=nativeReviewSessionId(entry.sourceId,entry.installationId,entry.nativeSessionId)
  const storage={
    ...noopStorage,
    nativeSessionCatalog:{async getByReviewSessionId(id:string){return id===nativeId?entry:null}},
  } as unknown as StorageService
  let reads=0
  const reader:NativeSessionWindowReader={
    async read(){throw Error('Hook endpoint must not scan native history')},
    async readArchivedHooks(query){
      reads++
      assert.equal(query.sourceId,'codex')
      assert.equal(query.nativeSessionId,'S-hook')
      return {state:'available',observations:[{
        kind:'tool.call' as const,capturedAt:at,
        payload:{nativeToolName:'Read',callId:'hook-1'},
        identityHints:{nativeSessionId:'S-hook'},
      }],observationRecordIds:['hook-record-1'],truncated:false}
    },
  }
  const server=await startHttpSurface(storage,{port:0,nativeSessionReader:reader})
  try {
    const base=`http://${server.host}:${server.port}/api/v1/native-sessions/${nativeId}/hooks`
    const response=await fetch(base)
    assert.equal(response.status,200)
    const data=await response.json() as {state:string;boundaryIntegrity:string;sessionId:string;hookEventsTruncated:boolean;hookFactsPartial:boolean}
    assert.equal(data.state,'available')
    assert.equal(data.boundaryIntegrity,'partial')
    assert.equal(data.sessionId,nativeId)
    assert.equal(data.hookEventsTruncated,false)
    assert.equal(data.hookFactsPartial,true,'Hook archive EOF is not proof of lifecycle completeness')
    assert.equal(JSON.stringify(data).includes('/private/session.jsonl'),false)
    assert.equal((await fetch(base+'?filePath=/etc/passwd')).status,400)
    assert.equal((await fetch(base,{method:'POST'})).status,405)
    assert.equal((await fetch(base.replace(nativeId,`native:${'0'.repeat(32)}`))).status,404)
    assert.equal(reads,1)
  }finally{await server.dispose()}
})
test('native complete-turn boundaries honor source nativeCallId and reject unpaired tools', async () => {
  const at = '2026-10-25T00:00:00Z'
  for (const mode of ['paired', 'pending', 'missing-id', 'orphan'] as const) {
    const observations = [
      {kind:'message.user' as const,capturedAt:at,payload:{text:'test'},
        identityHints:{nativeSessionId:'S1'}},
      ...(mode === 'orphan' ? [] : [{
        kind:'tool.call' as const,capturedAt:at,
        ...(mode === 'missing-id' ? {} : {nativeCallId:'normalized-1'}),
        payload:{nativeToolName:'shell'},identityHints:{nativeSessionId:'S1'},
      }]),
      ...(mode === 'paired' || mode === 'orphan' ? [{
        kind:'tool.result' as const,capturedAt:at,nativeCallId:'normalized-1',
        payload:{success:true,output:'ok'},identityHints:{nativeSessionId:'S1'},
      }] : []),
    ]
    const reader: NativeSessionWindowReader = {
      async read() {
        return {
          state:'available', observations,
          observationRecordIds:observations.map((_,i)=>'record-'+i),
          observationCursors:observations.map((_,i)=>({
            offset:i*64,sequence:i,fileIdentity:'1:2',
          })),
          evidenceCandidates:[],
          nextCursor:{offset:observations.length*64,sequence:observations.length,fileIdentity:'1:2'},
          hasMore:false,pendingTail:false,
        }
      },
    }
    const surface=await startHttpSurface(noopStorage,{port:0,nativeSessionReader:reader})
    try {
      const url=`http://${surface.host}:${surface.port}/api/v1/native-sessions/window?sourceId=pi&installationId=inst&nativeSessionId=S1&format=review-turns`
      const res=await fetch(url)
      assert.equal(res.status,200)
      const body=await res.json() as {
        state:string;reason?:string;boundaryIntegrity?:string;
        interactions?:Array<{nodes:Array<{type:string;callId?:string;status?:string}>}>
      }
      if (mode === 'paired') {
        assert.equal(body.state,'available')
        assert.equal(body.boundaryIntegrity,'complete')
        const tool=body.interactions?.[0]?.nodes.find(node=>node.type==='tool')
        assert.equal(tool?.callId,'normalized-1')
        assert.equal(tool?.status,'success')
      } else {
        assert.equal(body.state,'unsupported')
        assert.equal(body.reason,mode==='pending'
          ? 'native-review-turn-tool-pending'
          : mode==='missing-id' ? 'native-review-turn-tool-id-missing'
            : 'native-review-turn-orphan-tool-result')
        assert.equal(body.interactions,undefined)
      }
    } finally { await surface.dispose() }
  }
})

test('native Hook Review preserves bounded cursor and rejects attempts to override source identity',async()=>{
  const at='2026-10-25T00:00:00Z'
  const entry:NativeSessionCatalogEntry={
    sourceId:'claude-code',installationId:'c1',nativeSessionId:'S-hooks',
    locationKind:'native',filePath:'/private/native.jsonl',
    fileIdentity:'3:4',fileSize:2048,fileMtimeMs:1,lastActivityAt:at,updatedAt:at,
  }
  const id=nativeReviewSessionId(entry.sourceId,entry.installationId,entry.nativeSessionId)
  const storage={...noopStorage,nativeSessionCatalog:{
    async getByReviewSessionId(value:string){return value===id?entry:null},
  }} as unknown as StorageService
  const cursor=Buffer.from('source-owned-continuation','utf8').toString('base64url')
  const requested:string[]=[]
  const reader:NativeSessionWindowReader={
    async read(){throw Error('Hook-only request must not read main transcript')},
    async readArchivedHooks(query){
      assert.equal(query.sourceId,entry.sourceId)
      assert.equal(query.nativeSessionId,entry.nativeSessionId)
      requested.push(query.cursor??'')
      return {
        state:'available',observations:[{
          kind:'permission.request' as const,capturedAt:at,
          payload:{toolName:'Read',requestId:query.cursor?'second':'first'},
          identityHints:{nativeSessionId:entry.nativeSessionId},
        }],
        observationRecordIds:[query.cursor?'event-2':'event-1'],
        truncated:!query.cursor,
        ...(query.cursor?{}:{nextCursor:cursor}),
      }
    },
  }
  const app=await startHttpSurface(storage,{port:0,nativeSessionReader:reader})
  try{
    const base=`http://${app.host}:${app.port}/api/v1/native-sessions/${id}/hooks`
    const first=await fetch(base)
    assert.equal(first.status,200)
    const page1=await first.json() as {
      state:string;boundaryIntegrity:string;nextCursor:string;
      hasMore:boolean;hookEventsTruncated:boolean;interactions:unknown[]
    }
    assert.equal(page1.state,'available')
    assert.equal(page1.boundaryIntegrity,'partial')
    assert.equal(page1.hasMore,true)
    assert.equal(page1.nextCursor,cursor)
    assert.equal(page1.hookEventsTruncated,true)
    const second=await fetch(base+'?cursor='+encodeURIComponent(page1.nextCursor))
    assert.equal(second.status,200)
    const page2=await second.json() as typeof page1
    assert.equal(page2.hasMore,false)
    assert.equal(page2.hookEventsTruncated,false)
    assert.equal(page2.boundaryIntegrity,'partial')
    assert.deepEqual(requested,['',cursor])
    assert.equal(JSON.stringify([page1,page2]).includes('/private'),false)
    assert.equal((await fetch(base+'?cursor='+cursor+'&sourceId=pi')).status,400)
    assert.equal((await fetch(base+'?cursor='+cursor+'&cursor='+cursor)).status,400)
    assert.equal((await fetch(base+'?cursor=../../etc/passwd')).status,400)
  }finally{await app.dispose()}
})

test('native Review preserves completed turns while the following live tool is pending',async()=>{
  const at='2026-10-25T00:00:00Z'
  const records:Array<{kind:'message.user'|'message.assistant'|'tool.call'|'tool.result';
    payload:Record<string,unknown>}>= [
      {kind:'message.user',payload:{text:'first'}},
      {kind:'message.assistant',payload:{text:'finished one'}},
      {kind:'message.user',payload:{text:'second'}},
      {kind:'tool.call',payload:{callId:'still-running',nativeToolName:'shell'}},
    ]
  const reader:NativeSessionWindowReader={
    async read(query){
      const start=(query.cursor?.offset??0)/64
      const selected=records.slice(start,start+2)
      const next=start+selected.length
      return {
        state:'available',observations:selected.map((item,i)=>({
          ...item,capturedAt:at,sourceSequence:start+i,
          identityHints:{nativeSessionId:'S-live'},
        })),
        observationRecordIds:selected.map((_,i)=>'row-'+(start+i)),
        observationCursors:selected.map((_,i)=>({
          offset:(start+i)*64,sequence:start+i,fileIdentity:'session-inode',
        })),
        evidenceCandidates:[],
        nextCursor:{offset:next*64,sequence:next,fileIdentity:'session-inode'},
        hasMore:next<records.length,pendingTail:false,
      }
    },
  }
  const http=await startHttpSurface(noopStorage,{port:0,nativeSessionReader:reader})
  const url=`http://${http.host}:${http.port}/api/v1/native-sessions/window?sourceId=pi&installationId=inst&nativeSessionId=S-live&format=review-turns&turnLimit=4`
  try{
    const first=await fetch(url)
    assert.equal(first.status,200)
    const p1=await first.json() as {
      state:string;boundaryIntegrity:string;hasMore:boolean;nextCursor:string;
      interactions:Array<{ordinal:number;nodes:Array<{type:string;text?:string}>}>
    }
    assert.equal(p1.state,'available')
    assert.equal(p1.boundaryIntegrity,'complete')
    assert.deepEqual(p1.interactions.map(item=>item.ordinal),[1])
    assert.equal(p1.hasMore,true)
    assert.ok(p1.nextCursor)
    assert.equal(JSON.stringify(p1).includes('still-running'),false)

    const pending=await fetch(url+'&cursor='+encodeURIComponent(p1.nextCursor))
    const blocked=await pending.json() as {state:string;reason:string}
    assert.equal(blocked.state,'unsupported')
    assert.equal(blocked.reason,'native-review-turn-tool-pending')

    records.push(
      {kind:'tool.result',payload:{callId:'still-running',success:true,output:'ok'}},
      {kind:'message.assistant',payload:{text:'finished two'}},
    )
    const final=await fetch(url+'&cursor='+encodeURIComponent(p1.nextCursor))
    assert.equal(final.status,200)
    const p2=await final.json() as {
      state:string;boundaryIntegrity:string;hasMore:boolean;
      interactions:Array<{ordinal:number;nodes:Array<{type:string;status?:string}>}>
    }
    assert.equal(p2.state,'available')
    assert.equal(p2.boundaryIntegrity,'complete')
    assert.deepEqual(p2.interactions.map(item=>item.ordinal),[2])
    assert.equal(p2.hasMore,false)
    assert.equal(p2.interactions[0]?.nodes.find(item=>item.type==='tool')?.status,'success')
  } finally { await http.dispose() }
})

test('Catalog native Review shares one Task DTO with bounded Hook-exclusive facts, not duplicated tool calls',async()=>{
  const at='2026-10-25T04:00:00Z'
  const entry:NativeSessionCatalogEntry={
    sourceId:'claude-code',installationId:'claude-inst',nativeSessionId:'S-hook-merge',
    locationKind:'native',filePath:'/private/source.jsonl',
    fileIdentity:'5:6',fileSize:1024,fileMtimeMs:1,lastActivityAt:at,updatedAt:at,
  }
  const nativeId=nativeReviewSessionId(entry.sourceId,entry.installationId,entry.nativeSessionId)
  const storage={...noopStorage,nativeSessionCatalog:{
    async getByReviewSessionId(id:string){return id===nativeId?entry:null},
  }} as unknown as StorageService
  let hookReads=0
  const reader:NativeSessionWindowReader={
    async read(){
      const items=[
        {kind:'message.user' as const,capturedAt:at,occurredAt:at,
          payload:{text:'Original source prompt'},identityHints:{nativeSessionId:entry.nativeSessionId}},
        {kind:'message.assistant' as const,capturedAt:at,occurredAt:'2026-10-25T04:00:04Z',
          payload:{text:'Original answer'},identityHints:{nativeSessionId:entry.nativeSessionId}},
      ]
      return {state:'available',observations:items,
        observationRecordIds:['native-user','native-assistant'],
        observationCursors:[
          {offset:0,sequence:0,fileIdentity:'5:6'},
          {offset:64,sequence:1,fileIdentity:'5:6'},
        ],
        evidenceCandidates:[],
        nextCursor:{offset:128,sequence:2,fileIdentity:'5:6'},
        hasMore:false,pendingTail:false,
      }
    },
    async readArchivedHooks(query){
      hookReads++
      assert.equal(query.sourceId,entry.sourceId)
      assert.equal(query.nativeSessionId,entry.nativeSessionId)
      const one=query.cursor===undefined
      return {
        state:'available',
        observations: one ? [
          {kind:'permission.request' as const,capturedAt:at,
            occurredAt:'2026-10-25T04:00:01Z',payload:{toolName:'shell'},
            identityHints:{nativeSessionId:entry.nativeSessionId}},
          {kind:'tool.call' as const,capturedAt:at,
            occurredAt:'2026-10-25T04:00:02Z',payload:{callId:'duplicate-tool'},
            identityHints:{nativeSessionId:entry.nativeSessionId}},
        ] : [{
          kind:'subagent.spawn' as const,capturedAt:at,
          occurredAt:'2026-10-25T04:00:03Z',payload:{nativeActorId:'child-1'},
          identityHints:{nativeSessionId:entry.nativeSessionId},
        }],
        observationRecordIds:one?['hook-permission','hook-tool']:['hook-subagent'],
        truncated:one,...(one?{nextCursor:'hook-page-two'}:{}),
      }
    },
  }
  const old=process.env.AGENT_LENS_NATIVE_HOOK_ARCHIVE
  delete process.env.AGENT_LENS_NATIVE_HOOK_ARCHIVE
  const app=await startHttpSurface(storage,{port:0,nativeSessionReader:reader})
  try{
    const base=`http://${app.host}:${app.port}/api/v1/native-sessions`
    const response=await fetch(base+'/'+encodeURIComponent(nativeId)+'/review')
    assert.equal(response.status,200)
    const dto=await response.json() as {
      state:string;boundaryIntegrity:string;hookEventsTruncated?:boolean;hookFactsPartial?:boolean;
      interactions:Array<{nodes:Array<{type:string;kind?:string;payload?:unknown}>}>
    }
    assert.equal(dto.state,'available')
    assert.equal(dto.boundaryIntegrity,'complete')
    assert.equal(dto.hookEventsTruncated,undefined,'default-on archive completes bounded archived page')
    assert.equal(dto.hookFactsPartial,true,'tool hooks remain on standalone evidence lane')
    assert.equal(hookReads,2)
    assert.deepEqual(dto.interactions[0]?.nodes.map(node=>node.kind??node.type),[
      'message','permission.request','subagent.spawn','message',
    ])
    assert.equal(JSON.stringify(dto).includes('duplicate-tool'),false)
    assert.equal(JSON.stringify(dto).includes('/private'),false)
    const ordinary=await fetch(base+'/window?sourceId=claude-code&installationId=claude-inst&nativeSessionId=S-hook-merge&format=review-turns')
    assert.equal(ordinary.status,200)
    const native=await ordinary.json() as typeof dto
    assert.equal(native.interactions[0]?.nodes.length,2,'raw native window must remain Hook-free')
    assert.equal(hookReads,2)
    // The same Source transcript remains readable without a Hook reader,
    // but must never masquerade as complete Hook coverage.
    const readerUnavailable=await startHttpSurface(storage,{
      port:0,nativeSessionReader:{read:reader.read},
    })
    try {
      const noHook=await fetch(`http://${readerUnavailable.host}:${readerUnavailable.port}/api/v1/native-sessions/${encodeURIComponent(nativeId)}/review`)
      const noHookDto=await noHook.json() as typeof dto
      assert.equal(noHook.status,200)
      assert.equal(noHookDto.boundaryIntegrity,'complete')
      assert.equal(noHookDto.hookFactsPartial,true)
      assert.equal(noHookDto.hookEventsTruncated,true)
      assert.deepEqual(noHookDto.interactions[0]?.nodes.map(node=>node.kind??node.type),
        ['message','message'])
      assert.equal(hookReads,2,'missing Hook Reader never claims source facts')
    }finally{await readerUnavailable.dispose()}
    process.env.AGENT_LENS_NATIVE_HOOK_ARCHIVE='0'
    const disabled = await fetch(base+'/'+encodeURIComponent(nativeId)+'/review')
    assert.equal(disabled.status,200)
    const partial = await disabled.json() as typeof dto
    assert.equal(partial.hookEventsTruncated,true,
      'emergency archive disable cannot advertise complete Hook availability')
    assert.equal(partial.boundaryIntegrity,'complete',
      'verified transcript turns remain complete even if Hook evidence is partial')
  }finally{
    if(old===undefined)delete process.env.AGENT_LENS_NATIVE_HOOK_ARCHIVE
    else process.env.AGENT_LENS_NATIVE_HOOK_ARCHIVE=old
    await app.dispose()
  }
})

test('native Hermes-style anonymous tool facts remain visible when a later native user boundary is proven',async()=>{
  const at='2026-10-25T04:00:00Z'
  const events=[
    {kind:'message.user' as const,payload:{text:'first task'}},
    {kind:'tool.call' as const,payload:{nativeToolName:'shell',input:{command:'pwd'}}},
    {kind:'tool.result' as const,payload:{output:'result without call id'}},
    {kind:'message.assistant' as const,payload:{text:'finished first'}},
    {kind:'message.user' as const,payload:{text:'second task'}},
    {kind:'message.assistant' as const,payload:{text:'finished second'}},
  ]
  const reader:NativeSessionWindowReader={
    async read(query){
      const begin=(query.cursor?.offset??0)/64
      const selected=events.slice(begin)
      return {
        state:'available',observations:selected.map((e,i)=>({
          ...e,capturedAt:at,sourceSequence:begin+i,
          identityHints:{nativeSessionId:'S-anonymous'},
        })),
        observationRecordIds:selected.map((_,i)=>'r-'+(begin+i)),
        observationCursors:selected.map((_,i)=>({
          offset:64*(begin+i),sequence:begin+i,fileIdentity:'1:2',
        })),
        evidenceCandidates:[],
        nextCursor:{offset:events.length*64,sequence:events.length,fileIdentity:'1:2'},
        hasMore:false,pendingTail:false,
      }
    },
  }
  const app=await startHttpSurface(noopStorage,{port:0,nativeSessionReader:reader})
  const url=`http://${app.host}:${app.port}/api/v1/native-sessions/window?sourceId=hermes&installationId=inst&nativeSessionId=S-anonymous&format=review-turns`
  try{
    const first=await fetch(url)
    assert.equal(first.status,200)
    const body=await first.json() as {
      state:string;boundaryIntegrity:string;hasMore:boolean;nextCursor:string;
      interactions:Array<{nodes:Array<{type:string;kind?:string;status?:string;callId?:string}>}>
    }
    assert.equal(body.state,'available')
    assert.equal(body.boundaryIntegrity,'complete')
    assert.equal(body.hasMore,true)
    assert.deepEqual(body.interactions[0]?.nodes.map(n=>n.kind??n.type),[
      'message','tool','tool.result','message',
    ])
    const tool=body.interactions[0]?.nodes.find(n=>n.type==='tool')
    assert.equal(tool?.status,'unknown')
    assert.equal(tool?.callId,undefined)
    const next=await fetch(url+'&cursor='+encodeURIComponent(body.nextCursor))
    const rest=await next.json() as typeof body
    assert.equal(rest.state,'available')
    assert.equal(rest.boundaryIntegrity,'complete')
    assert.equal(rest.hasMore,false)
    assert.deepEqual(rest.interactions[0]?.nodes.map(n=>n.type),['message','message'])
  } finally {await app.dispose()}
})


test('complete native user turn carries exact SourceRecord Evidence without exposing file path',async()=>{
  const at='2026-10-25T00:00:00Z'
  const reader:NativeSessionWindowReader={
    async read(){
      return {
        state:'available',
        observations:[
          {kind:'message.user' as const,capturedAt:at,payload:{text:'run'},identityHints:{nativeSessionId:'S-evidence'}},
          {kind:'tool.call' as const,capturedAt:at,nativeCallId:'cmd1',
            payload:{nativeToolName:'shell'},identityHints:{nativeSessionId:'S-evidence'}},
          {kind:'tool.result' as const,capturedAt:at,nativeCallId:'cmd1',
            payload:{success:true,output:'ok'},identityHints:{nativeSessionId:'S-evidence'}},
        ],
        observationRecordIds:['prompt-1','shell-1','shell-1'],
        observationCursors:[
          {offset:0,sequence:0,fileIdentity:'file-inode'},
          {offset:64,sequence:1,fileIdentity:'file-inode'},
          {offset:64,sequence:1,fileIdentity:'file-inode'},
        ],
        evidenceCandidates:[
          {captureMethod:'native-log' as const,derivation:'reported' as const,
            sourceRecordId:'shell-1',confidenceHint:'high' as const,
            capturedAt:at,sourceLocator:{kind:'file' as const,path:'/private/opaque.jsonl',offset:64}},
          {captureMethod:'native-log' as const,derivation:'reported' as const,
            sourceRecordId:'not-current',capturedAt:at,
            sourceLocator:{kind:'file' as const,path:'/private/wrong.jsonl'}},
        ],
        nextCursor:{offset:128,sequence:2,fileIdentity:'file-inode'},
        hasMore:false,pendingTail:false,
      }
    },
  }
  const surface=await startHttpSurface(noopStorage,{port:0,nativeSessionReader:reader})
  try{
    const url=`http://${surface.host}:${surface.port}/api/v1/native-sessions/window?sourceId=pi&installationId=inst&nativeSessionId=S-evidence&format=review-turns`
    const response=await fetch(url)
    assert.equal(response.status,200)
    const payload=await response.json() as {
      state:string;boundaryIntegrity:string;
      interactions:Array<{nodes:Array<{type:string;evidence:Array<{id:string;confidence:string;captureMethod:string}>}>}>
    }
    assert.equal(payload.state,'available')
    assert.equal(payload.boundaryIntegrity,'complete')
    const tool=payload.interactions[0]?.nodes.find(node=>node.type==='tool')
    assert.equal(tool?.evidence.length,1)
    assert.equal(tool?.evidence[0]?.confidence,'high')
    assert.equal(tool?.evidence[0]?.captureMethod,'native-log')
    assert.equal(JSON.stringify(payload).includes('/private/'),false)
    assert.equal(JSON.stringify(payload).includes('not-current'),false)
    assert.equal(JSON.stringify(payload).includes('sourceLocator'),false)
  }finally{await surface.dispose()}
})

test('native Review never silently truncates more than 512 provenance candidates',async()=>{
  const reader:NativeSessionWindowReader={
    async read(){
      return {
        state:'available',
        observations:[{
          kind:'message.user' as const,capturedAt:'2026-10-25T00:00:00Z',
          payload:{text:'check evidence'},identityHints:{nativeSessionId:'S1'},
        }],
        observationRecordIds:['native-r1'],
        observationCursors:[{offset:0,sequence:0,fileIdentity:'inode-1'}],
        evidenceCandidates:Array.from({length:513},(_,i)=>({
          captureMethod:'native-log' as const,derivation:'observed' as const,
          sourceRecordId:'native-r1',capturedAt:'2026-10-25T00:00:00Z',
          nativeStableId:'e-'+i,
        })),
        nextCursor:{offset:100,sequence:1,fileIdentity:'inode-1'},
        hasMore:false,pendingTail:false,
      }
    },
  }
  const surface=await startHttpSurface(noopStorage,{port:0,nativeSessionReader:reader})
  try{
    for(const format of ['review','review-turns']){
      const response=await fetch(`http://${surface.host}:${surface.port}/api/v1/native-sessions/window?sourceId=pi&installationId=inst&nativeSessionId=S1&format=${format}`)
      assert.equal(response.status,200)
      assert.deepEqual(await response.json(),{
        state:'unsupported',reason:'native-review-evidence-budget',
      })
    }
  }finally{await surface.dispose()}
})


test('opaque JSONL cursor retains a bounded fingerprint and rejects malformed hash',async()=>{
  const hash='a'.repeat(64)
  const raw=encodeNativeSessionCursor({
    offset:128,sequence:2,fileIdentity:'1:2',boundaryHash:hash,
    mode:'review-turns',turnOrdinal:3,
  })
  const seen:Array<Record<string,unknown>>=[]
  const reader:NativeSessionWindowReader={
    async read(query){
      seen.push({...query.cursor})
      return {state:'unsupported',reason:'test-reader'}
    },
  }
  const surface=await startHttpSurface(noopStorage,{port:0,nativeSessionReader:reader})
  const endpoint=`http://${surface.host}:${surface.port}/api/v1/native-sessions/window?sourceId=pi&installationId=inst&nativeSessionId=S1&format=review-turns`
  try{
    const result=await fetch(endpoint+'&cursor='+raw)
    assert.equal(result.status,200)
    assert.deepEqual(seen,[{
      offset:128,sequence:2,fileIdentity:'1:2',boundaryHash:hash,
      mode:'review-turns',turnOrdinal:3,
    }])
    const malicious=Buffer.from(JSON.stringify({
      offset:128,sequence:2,fileIdentity:'1:2',
      boundaryHash:'not-a-hash',mode:'review-turns',turnOrdinal:3,
    })).toString('base64url')
    assert.equal((await fetch(endpoint+'&cursor='+malicious)).status,400)
    const extra=Buffer.from(JSON.stringify({
      offset:128,sequence:2,fileIdentity:'1:2',
      boundaryHash:hash,mode:'review-turns',turnOrdinal:3,
      arbitraryFilePath:'/private/native.jsonl',
    })).toString('base64url')
    assert.equal((await fetch(endpoint+'&cursor='+extra)).status,400)
    assert.equal(seen.length,1,'unsafe cursors cannot reach the Source reader')
  }finally{await surface.dispose()}
})

