import assert from 'node:assert/strict'
import test from 'node:test'
import type { StorageService } from '@agent-lens/core'
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
      return {
        state:'available',observations:[observation],observationRecordIds:['r'+n],
        ...(mode==='missing-rewind'?{}:{observationCursors:[{offset,sequence:n,fileIdentity:'1:2'}]}),
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
