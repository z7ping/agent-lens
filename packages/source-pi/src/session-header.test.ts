import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { piInternals } from './index'

test('Pi session header discovery skips blank and malformed physical rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-header-'))
  const file = join(root, 'session.jsonl')
  const header = {
    type: 'session',
    version: 3,
    id: 'native-session-id',
    timestamp: '2026-09-10T00:00:00.000Z',
    cwd: root,
  }
  await writeFile(file, `\n{not-json}\n${JSON.stringify(header)}\n`, 'utf8')
  try {
    assert.deepEqual(await piInternals.readSessionHeader(file), header)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Pi session header discovery accepts a complete final header without newline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-header-eof-'))
  const file = join(root, 'session.jsonl')
  const header = {
    type: 'session',
    version: 3,
    id: 'native-session-eof',
    timestamp: '2026-09-10T00:00:00.000Z',
    cwd: root,
  }
  await writeFile(file, JSON.stringify(header), 'utf8')
  try {
    assert.deepEqual(await piInternals.readSessionHeader(file), header)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Pi session header discovery stops when the first parsed entry is not a session header', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-header-invalid-'))
  const file = join(root, 'session.jsonl')
  await writeFile(file, [
    JSON.stringify({ type: 'message', id: 'not-a-header' }),
    JSON.stringify({ type: 'session', id: 'too-late', cwd: root }),
    '',
  ].join('\n'), 'utf8')
  try {
    assert.equal(await piInternals.readSessionHeader(file), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
