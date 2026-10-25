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
