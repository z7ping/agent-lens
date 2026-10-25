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
      return {
        state: 'available',
        observations: [{
          kind: 'message.user',
          capturedAt: '2026-10-25T00:00:00Z',
          identityHints: { nativeSessionId: 'session 1' },
          payload: { text: '[redacted]' },
        }],
        evidenceCandidates: [{
          captureMethod: 'native-log',
          derivation: 'observed',
          capturedAt: '2026-10-25T00:00:00Z',
          sourceLocator: { kind: 'file', path: '/sensitive/work/secret.jsonl' },
        }],
        nextCursor: { offset: 128, sequence: 1, fileIdentity: '1:2' },
        hasMore: true,
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

    const second = await fetch(`${endpoint}?sourceId=pi&installationId=inst&nativeSessionId=session%201&limit=2&cursor=${body.nextCursor}`)
    assert.equal(second.status, 200)
    assert.deepEqual(calls, [{
      sourceId: 'pi', installationId: 'inst', nativeSessionId: 'session 1', limit: 8, hasAbortSignal: true,
    }, {
      sourceId: 'pi', installationId: 'inst', nativeSessionId: 'session 1', limit: 2,
      cursor: { offset: 128, sequence: 1, fileIdentity: '1:2' }, hasAbortSignal: true,
    }])
  } finally {
    await server.dispose()
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
