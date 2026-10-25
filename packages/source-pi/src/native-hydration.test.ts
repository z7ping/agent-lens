import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SourceRawRecoveryContext, SourceRecord } from '@agent-lens/core'
import { piManifest, piSourceDefinition } from './index'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

test('Pi: metadata-only reference hydrates an original event and reuses the original normalizer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-hydrate-'))
  const dataRoot = join(root, 'sessions')
  const path = join(dataRoot, 'session.jsonl')
  const header = JSON.stringify({ type: 'session', id: 'pi-original', cwd: '/workspace/test' })
  const event = JSON.stringify({
    type: 'message', id: 'user-entry-1',
    message: { role: 'user', content: 'hello from native Pi' },
  })
  const reference: SourceRecord = {
    id: 'pi-record-1',
    sourceId: 'pi', installationId: 'pi-installation',
    sourceSessionNativeId: 'pi-original',
    nativeType: 'history/message', nativeId: 'user-entry-1',
    sourceSequence: 2000, capturedAt: '2026-10-25T00:00:00Z',
    locator: { kind: 'file', path, offset: Buffer.byteLength(header + '\n') },
    fingerprint: hash(event), parserVersion: piManifest.parserVersion, payload: null,
  }
  const host: SourceRawRecoveryContext['host'] = {
    id: 'host-1', name: 'test', platform: process.platform, arch: process.arch,
    createdAt: '2026-10-25T00:00:00Z', lastSeenAt: '2026-10-25T00:00:00Z',
  }
  const installation: SourceRawRecoveryContext['installation'] = {
    id: 'pi-installation', hostId: host.id, productId: 'pi', dataRoot,
    firstSeenAt: '2026-10-25T00:00:00Z', lastSeenAt: '2026-10-25T00:00:00Z',
  }
  const ctx: SourceRawRecoveryContext = {
    host, installation, abortSignal: new AbortController().signal,
    checkpoint: { async get() { return null }, async set() {}, async clear() {} },
  }
  try {
    await mkdir(dataRoot, { recursive: true })
    await writeFile(path, header + '\n' + event + '\n', 'utf8')
    const hydrate = piSourceDefinition.rawRecovery!.hydrate!
    const actual = await hydrate(reference, ctx)
    assert.equal(actual.state, 'available')
    if (actual.state !== 'available') return
    assert.deepEqual(actual.record.payload, {
      entry: JSON.parse(event),
      session: { nativeSessionId: 'pi-original', cwd: '/workspace/test' },
    })
    const normalized = await piSourceDefinition.normalize(actual.record, { host, installation })
    assert.equal(normalized.observations.some(item => item.kind === 'message.user'), true)

    assert.deepEqual(await hydrate({ ...reference, parserVersion: 'old-parser' }, ctx), {
      state: 'incompatible', reason: 'source-parser-version-changed',
    })
    assert.deepEqual(await hydrate({ ...reference, installationId: 'different' }, ctx), {
      state: 'unsupported', reason: 'source-installation-mismatch',
    })
    const drifted = await hydrate({ ...reference, fingerprint: hash('wrong') }, ctx)
    assert.equal(drifted.state, 'drifted')
    assert.deepEqual(await hydrate({ ...reference, sourceSessionNativeId: 'other' }, ctx), {
      state: 'drifted', reason: 'source-native-session-identity-changed',
    })
    const outside = join(root, 'outside.jsonl')
    await writeFile(outside, header + '\n' + event + '\n', 'utf8')
    assert.deepEqual(await hydrate({
      ...reference, locator: { kind: 'file', path: outside, offset: reference.locator.offset! },
    }, ctx), { state: 'unsupported', reason: 'source-path-outside-authorized-roots' })

    const abort = new AbortController()
    abort.abort()
    await assert.rejects(hydrate(reference, { ...ctx, abortSignal: abort.signal }))
    await rm(path)
    assert.deepEqual(await hydrate(reference, ctx), { state: 'unavailable', reason: 'source-file-missing' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test('Pi session page reads native messages by cursor without checkpoints or event persistence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-page-'))
  const path = join(root, 'session.jsonl')
  const header = JSON.stringify({ type: 'session', id: 'pi-page' })
  const message = (id: number) => JSON.stringify({ type: 'message', id: `msg-${id}`,
    message: { role: 'user', content: `turn ${id}` } })
  const host = { id: 'host', name: 'host', platform: process.platform, arch: process.arch,
    createdAt: '2026-10-25T00:00:00Z', lastSeenAt: '2026-10-25T00:00:00Z' }
  const installation = { id: 'pi-page-inst', hostId: host.id, productId: 'pi', dataRoot: root,
    firstSeenAt: '2026-10-25T00:00:00Z', lastSeenAt: '2026-10-25T00:00:00Z' }
  let checkpointCalls = 0
  const ctx: SourceRawRecoveryContext = { host, installation, abortSignal: new AbortController().signal,
    checkpoint: { async get() { checkpointCalls++; return null }, async set() { checkpointCalls++ },
      async clear() { checkpointCalls++ } } }
  try {
    await writeFile(path, [header, message(1), message(2)].join('\n') + '\n')
    const read = piSourceDefinition.readNativeSessionPage!
    const first = await read({ filePath: path, nativeSessionId: 'pi-page', limit: 2 }, ctx)
    assert.equal(first.state, 'available')
    if (first.state !== 'available') return
    assert.equal(first.records.length, 2)
    assert.equal(first.hasMore, true)
    const next = await read({ filePath: path, nativeSessionId: 'pi-page', cursor: first.nextCursor, limit: 2 }, ctx)
    assert.equal(next.state, 'available')
    if (next.state !== 'available') return
    assert.deepEqual(next.records.map(x => x.nativeId), ['msg-1', 'msg-2'])
    assert.equal(next.hasMore, false)
    assert.equal(checkpointCalls, 0)
    const normalized = await piSourceDefinition.normalize(next.records[0]!, { host, installation })
    assert.equal(normalized.observations[0]?.kind, 'message.user')
    assert.deepEqual(await read({ filePath: path, nativeSessionId: 'wrong' }, ctx),
      { state: 'drifted', reason: 'native-session-identity-changed' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
