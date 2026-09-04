import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { piInternals } from './index'

test('Pi 冷导入按最近活动时间优先并稳定回填旧文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-order-'))
  const sessions = join(root, 'sessions')
  const oldPath = join(sessions, 'z-old.jsonl')
  const recentAPath = join(sessions, 'a-recent.jsonl')
  const recentBPath = join(sessions, 'b-recent.jsonl')
  await mkdir(sessions, { recursive: true })
  await Promise.all([
    writeFile(oldPath, '', 'utf8'),
    writeFile(recentAPath, '', 'utf8'),
    writeFile(recentBPath, '', 'utf8'),
  ])
  const oldTime = new Date('2026-08-01T00:00:00.000Z')
  const recentTime = new Date('2026-08-30T00:00:00.000Z')
  await utimes(oldPath, oldTime, oldTime)
  await utimes(recentAPath, recentTime, recentTime)
  await utimes(recentBPath, recentTime, recentTime)

  try {
    assert.deepEqual(await piInternals.listJsonlFiles(sessions), [
      recentBPath,
      recentAPath,
      oldPath,
    ])
    assert.deepEqual(await piInternals.listJsonlFiles(sessions, {
      activeSince: '2026-08-20T00:00:00.000Z',
      sessionLimit: 1,
    }), [recentBPath])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
