import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SourceRawRecoveryContext, SourceRecord } from '@agent-lens/core'
import { codexManifest, codexSourceDefinition } from './index'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

test('Codex: both active and native archived JSONL hydrate without persisting the payload', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-lens-codex-hydrate-'))
  const sessions = join(home, 'sessions')
  const archived = join(home, 'archived_sessions')
  const header = JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-10-25T00:00:00Z',
    payload: { id: 'codex-original', cwd: home, timestamp: '2026-10-25T00:00:00Z' },
  })
  const event = JSON.stringify({
    type: 'response_item', timestamp: '2026-10-25T00:00:01Z',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Codex native reply' }] },
  })
  const host: SourceRawRecoveryContext['host'] = {
    id: 'host-codex', name: 'test', platform: process.platform, arch: process.arch,
    createdAt: '2026-10-25T00:00:00Z', lastSeenAt: '2026-10-25T00:00:00Z',
  }
  const installation: SourceRawRecoveryContext['installation'] = {
    id: 'codex-installation', hostId: host.id, productId: 'codex',
    dataRoot: sessions, configRoot: home,
    firstSeenAt: '2026-10-25T00:00:00Z', lastSeenAt: '2026-10-25T00:00:00Z',
  }
  const ctx: SourceRawRecoveryContext = {
    host, installation, abortSignal: new AbortController().signal,
    checkpoint: { async get() { return null }, async set() {}, async clear() {} },
  }
  const hydrate = codexSourceDefinition.rawRecovery!.hydrate!
  try {
    await mkdir(sessions, { recursive: true })
    await mkdir(archived, { recursive: true })
    for (const folder of [sessions, archived]) {
      const path = join(folder, 'rollout.jsonl')
      await writeFile(path, header + '\n' + event + '\n', 'utf8')
      const reference: SourceRecord = {
        id: 'codex-2', sourceId: 'codex', installationId: installation.id,
        sourceSessionNativeId: 'codex-original', nativeType: 'history/response_item',
        sourceSequence: 2, capturedAt: '2026-10-25T00:00:01Z',
        locator: { kind: 'file', path, offset: Buffer.byteLength(header + '\n') },
        fingerprint: hash(event), parserVersion: codexManifest.parserVersion, payload: null,
      }
      const read = await hydrate(reference, ctx)
      assert.equal(read.state, 'available')
      if (read.state !== 'available') continue
      const payload = read.record.payload as { entry: unknown; session: { nativeSessionId: string } }
      assert.deepEqual(payload.entry, JSON.parse(event))
      assert.equal(payload.session.nativeSessionId, 'codex-original')
      const normalized = await codexSourceDefinition.normalize(read.record, { host, installation })
      assert.equal(normalized.observations.some(item => item.kind === 'message.assistant'), true)
      assert.deepEqual(await hydrate({ ...reference, sourceSessionNativeId: 'other' }, ctx), {
        state: 'drifted', reason: 'source-native-session-identity-changed',
      })
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})


test('Codex session page reads native events from active and archived roots without checkpoints', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-lens-codex-page-'))
  const sessions = join(home, 'sessions')
  const archived = join(home, 'archived_sessions')
  const header = JSON.stringify({ type: 'session_meta', payload: { id: 'codex-page' } })
  const message = (id: number) => JSON.stringify({ type: 'response_item', timestamp: '2026-10-25T00:00:00Z',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `reply ${id}` }] } })
  const host = { id: 'host', name: 'host', platform: process.platform, arch: process.arch,
    createdAt: '2026-10-25T00:00:00Z', lastSeenAt: '2026-10-25T00:00:00Z' }
  const installation = { id: 'codex-page-inst', hostId: host.id, productId: 'codex',
    configRoot: home, dataRoot: sessions,
    firstSeenAt: '2026-10-25T00:00:00Z', lastSeenAt: '2026-10-25T00:00:00Z' }
  let checkpointCalls = 0
  const ctx: SourceRawRecoveryContext = { host, installation, abortSignal: new AbortController().signal,
    checkpoint: { async get() { checkpointCalls++; return null }, async set() { checkpointCalls++ },
      async clear() { checkpointCalls++ } } }
  try {
    for (const folder of [sessions, archived]) {
      await mkdir(folder, { recursive: true })
      const path = join(folder, 'session.jsonl')
      await writeFile(path, [header, message(1), message(2)].join('\n') + '\n')
      const read = codexSourceDefinition.readNativeSessionPage!
      const first = await read({ filePath: path, nativeSessionId: 'codex-page', limit: 1 }, ctx)
      assert.equal(first.state, 'available')
      if (first.state !== 'available') continue
      assert.equal(first.records.length, 1)
      assert.deepEqual(first.recordCursors?.map(c => [c.offset,c.sequence]), [[0,0]])
      assert.equal(first.hasMore, true)
      const second = await read({ filePath: path, nativeSessionId: 'codex-page', limit: 2, cursor: first.nextCursor }, ctx)
      assert.equal(second.state, 'available')
      if (second.state !== 'available') continue
      assert.equal(second.records.length, 2)
      assert.equal(second.recordCursors?.[0]?.offset, first.nextCursor.offset)
      assert.equal(second.recordCursors?.[0]?.sequence, 1)
      assert.equal(second.recordCursors?.[1]?.sequence, 2)
      assert.equal(second.records[0]?.sourceSequence, 2)
      assert.equal(second.records[1]?.sourceSequence, 3)
      const normalized = await codexSourceDefinition.normalize(second.records[1]!, { host, installation })
      assert.equal(normalized.observations.some(x => x.kind === 'message.assistant'), true)
      assert.equal(second.hasMore, false)
      assert.deepEqual(await read({ filePath: path, nativeSessionId: 'wrong' }, ctx),
        { state: 'drifted', reason: 'native-session-identity-changed' })
      const original=await stat(path)
      assert.equal(first.nextCursor.fileIdentity,`${original.dev}:${original.ino}`)
      const replacement=join(folder,'replacement.jsonl')
      await writeFile(replacement,[header,message(1),message(2)].join('\n')+'\n')
      await rename(replacement,path)
      assert.deepEqual(await read({filePath:path,nativeSessionId:'codex-page',cursor:first.nextCursor},ctx),
        {state:'drifted',reason:'native-file-identity-changed'})
    }
    assert.equal(checkpointCalls, 0)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
