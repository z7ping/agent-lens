import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { latestPiSessionEntryId } from './session-disk-tail'

test('bounded tail probe returns newest complete non-header entry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-lens-pi-tail-'))
  const file = join(dir, 'session.jsonl')
  try {
    await writeFile(file, [
      JSON.stringify({ type: 'session', id: 'session-id' }),
      JSON.stringify({ type: 'message', id: 'entry-1' }),
      JSON.stringify({ type: 'message', id: 'entry-2' }),
      '',
    ].join('\n'))
    assert.equal(await latestPiSessionEntryId(file), 'entry-2')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('bounded tail probe ignores a torn trailing append', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-lens-pi-tail-'))
  const file = join(dir, 'session.jsonl')
  try {
    await writeFile(file, [
      JSON.stringify({ type: 'session', id: 'session-id' }),
      JSON.stringify({ type: 'message', id: 'entry-1' }),
      '{"type":"message","id":"entry-2"',
    ].join('\n'))
    assert.equal(await latestPiSessionEntryId(file), 'entry-1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('bounded tail probe ignores a header-only or missing session file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-lens-pi-tail-'))
  const file = join(dir, 'session.jsonl')
  try {
    await writeFile(file, JSON.stringify({ type: 'session', id: 'session-id' }) + '\r\n')
    assert.equal(await latestPiSessionEntryId(file), undefined)
    assert.equal(await latestPiSessionEntryId(join(dir, 'missing.jsonl')), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('bounded tail probe drops a partial first line when the read starts mid-file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-lens-pi-tail-'))
  const file = join(dir, 'session.jsonl')
  try {
    const padding = JSON.stringify({ type: 'message', id: 'old-entry', text: 'x'.repeat(512) })
    await writeFile(file, [
      JSON.stringify({ type: 'session', id: 'session-id' }),
      padding,
      JSON.stringify({ type: 'message', id: 'new-entry' }),
      '',
    ].join('\n'))
    assert.equal(await latestPiSessionEntryId(file, 96), 'new-entry')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})