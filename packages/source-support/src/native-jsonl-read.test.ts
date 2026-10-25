import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readVerifiedNativeJsonlObject } from './native-jsonl-read'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

test('single-read native JSONL reader hydrates the exact offset and validates its bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-native-jsonl-'))
  const path = join(root, 'session.jsonl')
  try {
    const first = JSON.stringify({ kind: 'session', id: 'S1' })
    const second = JSON.stringify({ kind: 'message', id: 'E2', text: '中文内容' })
    const offset = Buffer.byteLength(first + '\r\n')
    await writeFile(path, first + '\r\n' + second + '\r\n')
    const result = await readVerifiedNativeJsonlObject({ path, offset, expectedFingerprint: sha256(second) })
    assert.deepEqual(result, {
      state: 'available',
      entry: { kind: 'message', id: 'E2', text: '中文内容' },
      fingerprint: sha256(second),
      bytesRead: Buffer.byteLength(second) + 2,
    })

    const changed = await readVerifiedNativeJsonlObject({ path, offset, expectedFingerprint: sha256('wrong') })
    assert.equal(changed.state, 'drifted')
    if (changed.state === 'drifted') assert.equal(changed.currentFingerprint, sha256(second))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reader preserves absence, in-flight tail and unsupported source states', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-native-jsonl-states-'))
  const path = join(root, 'session.jsonl')
  try {
    const incomplete = '{"kind":"message","text":"writing"'
    await writeFile(path, incomplete)
    assert.deepEqual(await readVerifiedNativeJsonlObject({
      path, offset: 0, expectedFingerprint: sha256(incomplete),
    }), { state: 'pending', reason: 'source-record-not-terminated' })

    assert.deepEqual(await readVerifiedNativeJsonlObject({
      path, offset: 99999, expectedFingerprint: sha256(incomplete),
    }), { state: 'unavailable', reason: 'source-offset-missing' })

    assert.deepEqual(await readVerifiedNativeJsonlObject({
      path: join(root, 'missing.jsonl'), offset: 0, expectedFingerprint: sha256(incomplete),
    }), { state: 'unavailable', reason: 'source-file-missing' })

    assert.deepEqual(await readVerifiedNativeJsonlObject({
      path, offset: -1, expectedFingerprint: sha256(incomplete),
    }), { state: 'unsupported', reason: 'source-reference-incomplete' })

    const controller = new AbortController()
    controller.abort()
    await assert.rejects(readVerifiedNativeJsonlObject({
      path, offset: 0, expectedFingerprint: sha256(incomplete), abortSignal: controller.signal,
    }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reader refuses oversized, malformed and primitive records, without unbounded reading', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-native-jsonl-size-'))
  const path = join(root, 'session.jsonl')
  try {
    const large = JSON.stringify({ text: 'a'.repeat(150) })
    await writeFile(path, large + '\n')
    assert.deepEqual(await readVerifiedNativeJsonlObject({
      path, offset: 0, expectedFingerprint: sha256(large), maxRecordBytes: 60,
    }), { state: 'unsupported', reason: 'source-record-too-large' })

    const malformed = '{"not-valid"'
    await writeFile(path, malformed + '\n')
    assert.deepEqual(await readVerifiedNativeJsonlObject({
      path, offset: 0, expectedFingerprint: sha256(malformed),
    }), { state: 'unsupported', reason: 'source-record-invalid-json' })

    await writeFile(path, '42\n')
    assert.deepEqual(await readVerifiedNativeJsonlObject({
      path, offset: 0, expectedFingerprint: sha256('42'),
    }), { state: 'unsupported', reason: 'source-record-not-object' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
