import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
