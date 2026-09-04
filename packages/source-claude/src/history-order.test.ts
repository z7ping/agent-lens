import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { claudeInternals } from './index'

test('Claude 冷导入按最近活动时间优先并稳定回填旧文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-claude-order-'))
  const projects = join(root, 'projects')
  const oldPath = join(projects, 'z-old.jsonl')
  const recentAPath = join(projects, 'a-recent.jsonl')
  const recentBPath = join(projects, 'b-recent.jsonl')
  await mkdir(projects, { recursive: true })
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
    assert.deepEqual(await claudeInternals.listJsonlFiles(projects), [
      recentBPath,
      recentAPath,
      oldPath,
    ])
    assert.deepEqual(await claudeInternals.listJsonlFiles(projects, {
      activeSince: '2026-08-20T00:00:00.000Z',
      sessionLimit: 1,
    }), [recentBPath])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
