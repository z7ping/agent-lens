import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AgentInstallation, Host } from '@agent-lens/core'
import { NativeReaderWorkerClient } from '@agent-lens/core-services'
import { piManifest } from '@agent-lens/source-pi'
import { codexManifest } from '@agent-lens/source-codex'

const now = '2026-10-25T00:00:00Z'
const host: Host = {
  id: 'local-host', name: 'test', platform: process.platform, arch: process.arch,
  createdAt: now, lastSeenAt: now,
}
function installation(productId: string, root: string): AgentInstallation {
  return {
    id: `${productId}-install`, hostId: host.id, productId, dataRoot: root,
    configRoot: root, firstSeenAt: now, lastSeenAt: now,
  }
}

test('isolated Pi native Worker reads and normalizes actual JSONL without a database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-native-worker-'))
  const filePath = join(root, 'pi.jsonl')
  const worker = new NativeReaderWorkerClient()
  try {
    await writeFile(filePath, [
      JSON.stringify({ type: 'session', id: 'native-session', cwd: root }),
      JSON.stringify({ type: 'message', id: 'message-1',
        message: { role: 'user', content: 'test native worker' } }),
    ].join('\n') + '\n')
    const fileStat = await stat(filePath)
    const fileIdentity = `${fileStat.dev}:${fileStat.ino}`
    const result = await worker.read({
      sourceId: 'pi', parserVersion: piManifest.parserVersion, expectedFileIdentity: fileIdentity,
      host, installation: installation('pi', root),
      query: { filePath, nativeSessionId: 'native-session', limit: 10 },
    }, new AbortController().signal)
    assert.equal(result.state, 'available')
    if (result.state !== 'available') return
    assert.equal(result.entries.length, 2)
    assert.equal(result.entries[1]?.sourceId, 'pi')
    assert.ok(result.entries[1]?.recordId)
    assert.ok(result.entries[1]?.normalized.observations.some(item => item.kind === 'message.user'))
    assert.equal(result.hasMore, false)
    assert.equal(result.pendingTail, false)

    const bad = await worker.read({
      sourceId: 'pi', parserVersion: 'outdated', expectedFileIdentity: fileIdentity,
      host, installation: installation('pi', root),
      query: { filePath, nativeSessionId: 'native-session' },
    }, new AbortController().signal)
    assert.deepEqual(bad, { state: 'unsupported', reason: 'native-worker-parser-version-mismatch' })
  } finally {
    await worker.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('isolated Codex native Worker reads original archived_sessions and validates source path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-codex-native-worker-'))
  const archive = join(root, 'archived_sessions')
  const filePath = join(archive, 'rollout.jsonl')
  const worker = new NativeReaderWorkerClient()
  try {
    await mkdir(archive, { recursive: true })
    await writeFile(filePath, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-original', cwd: root } }),
      JSON.stringify({ type: 'response_item', timestamp: now,
        payload: { type: 'message', role: 'assistant',
          content: [{ type: 'output_text', text: 'worker output' }] } }),
    ].join('\n') + '\n')
    const fileStat = await stat(filePath)
    const fileIdentity = `${fileStat.dev}:${fileStat.ino}`
    const result = await worker.read({
      sourceId: 'codex', parserVersion: codexManifest.parserVersion, expectedFileIdentity: fileIdentity,
      host, installation: installation('codex', root),
      query: { filePath, nativeSessionId: 'codex-original', limit: 16 },
    }, new AbortController().signal)
    assert.equal(result.state, 'available')
    if (result.state === 'available') {
      assert.ok(result.entries.some(row => row.normalized.observations.some(x => x.kind === 'message.assistant')))
    }
    const escaped = await worker.read({
      sourceId: 'codex', parserVersion: codexManifest.parserVersion, expectedFileIdentity: fileIdentity,
      host, installation: installation('codex', join(root, 'another-root')),
      query: { filePath, nativeSessionId: 'codex-original' },
    }, new AbortController().signal)
    assert.deepEqual(escaped, { state: 'unsupported', reason: 'source-path-not-authorized' })
  } finally {
    await worker.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('native Worker cancellation and termination cannot leave a pending read alive', async () => {
  const client = new NativeReaderWorkerClient()
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(client.read({
    sourceId: 'pi', parserVersion: piManifest.parserVersion, expectedFileIdentity: 'missing',
    host, installation: installation('pi', '/missing'),
    query: { filePath: '/missing.jsonl', nativeSessionId: 'session' },
  }, aborted.signal))
  await client.dispose()
  await assert.rejects(client.read({
    sourceId: 'pi', parserVersion: piManifest.parserVersion, expectedFileIdentity: 'missing',
    host, installation: installation('pi', '/missing'),
    query: { filePath: '/missing.jsonl', nativeSessionId: 'session' },
  }, new AbortController().signal))
})
