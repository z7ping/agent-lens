import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { appendBoundedLogSync, createRotatingLogWriter } from './rotating-log.mjs'

test('Daemon 日志按大小轮转并保留有限历史', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-rotating-log-'))
  const path = join(root, 'daemon.log')
  try {
    const writer = await createRotatingLogWriter(path, { maxBytes: 8, backups: 2 })
    writer.write('12345678')
    writer.write('abcdefgh')
    writer.write('ijklmnop')
    await writer.flush()

    assert.equal(await readFile(path, 'utf8'), 'ijklmnop')
    assert.equal(await readFile(`${path}.1`, 'utf8'), 'abcdefgh')
    assert.equal(await readFile(`${path}.2`, 'utf8'), '12345678')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('启动日志同步写入同样按大小轮转', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-rotating-boot-log-'))
  const path = join(root, 'desktop.log')
  try {
    appendBoundedLogSync(path, '12345678', { maxBytes: 8, backups: 1 })
    appendBoundedLogSync(path, 'abcdefgh', { maxBytes: 8, backups: 1 })
    assert.equal(await readFile(path, 'utf8'), 'abcdefgh')
    assert.equal(await readFile(`${path}.1`, 'utf8'), '12345678')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
