import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { verifyJsonlLineSha256 } from './raw-recovery'

test('verifyJsonlLineSha256 区分 verified / drifted / unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-raw-recovery-'))
  const path = join(root, 'session.jsonl')
  try {
    const first = JSON.stringify({ id: 1, text: 'hello' })
    const second = JSON.stringify({ id: 2, text: 'world' })
    await writeFile(path, first + '\n' + second + '\n', 'utf8')
    const offset = Buffer.byteLength(first + '\n', 'utf8')
    const fingerprint = createHash('sha256').update(second).digest('hex')

    assert.equal((await verifyJsonlLineSha256({
      path,
      offset,
      expectedFingerprint: fingerprint,
    })).state, 'verified')

    await writeFile(path, first + '\n' + JSON.stringify({ id: 2, text: 'changed' }) + '\n', 'utf8')
    assert.equal((await verifyJsonlLineSha256({
      path,
      offset,
      expectedFingerprint: fingerprint,
    })).state, 'drifted')

    await rm(path)
    assert.equal((await verifyJsonlLineSha256({
      path,
      offset,
      expectedFingerprint: fingerprint,
    })).state, 'unavailable')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
