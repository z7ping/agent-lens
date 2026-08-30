import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SourceExecutionContext } from '@agent-lens/core'
import { codexHistoryInternals, ingestCodexHistory } from './history'

async function fixture(lineCount: number) {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-codex-checkpoint-'))
  const sessions = join(root, 'sessions')
  const path = join(sessions, 'rollout-checkpoint.jsonl')
  await mkdir(sessions, { recursive: true })
  const lines = Array.from({ length: lineCount }, (_, index) => JSON.stringify({
    timestamp: new Date(Date.UTC(2026, 7, 30, 0, 0, index)).toISOString(),
    type: 'event_msg',
    payload: { type: 'agent_message', message: `message-${index}` },
  }))
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
  return { root, sessions, path }
}

function context(
  sessions: string,
  checkpoints: Map<string, unknown>,
  writes: unknown[],
): SourceExecutionContext {
  return {
    host: {
      id: 'host-checkpoint',
      name: 'checkpoint-host',
      platform: process.platform,
      arch: process.arch,
      createdAt: '2026-08-30T00:00:00.000Z',
      lastSeenAt: '2026-08-30T00:00:00.000Z',
    },
    installation: {
      id: 'installation-checkpoint',
      hostId: 'host-checkpoint',
      productId: 'codex',
      dataRoot: sessions,
      firstSeenAt: '2026-08-30T00:00:00.000Z',
      lastSeenAt: '2026-08-30T00:00:00.000Z',
    },
    abortSignal: new AbortController().signal,
    checkpoint: {
      async get<T>(key: string) { return (checkpoints.get(key) as T | undefined) ?? null },
      async set<T>(key: string, value: T) {
        checkpoints.set(key, value)
        writes.push(value)
      },
      async clear(key: string) { checkpoints.delete(key) },
    },
  }
}

test('Codex 历史游标按批次写入并在文件末尾完整落盘', async () => {
  const input = await fixture(codexHistoryInternals.CHECKPOINT_BATCH_SIZE * 2 + 5)
  const checkpoints = new Map<string, unknown>()
  const writes: unknown[] = []

  try {
    let records = 0
    for await (const _record of ingestCodexHistory(context(input.sessions, checkpoints, writes))) {
      records += 1
    }

    const file = await stat(input.path)
    assert.equal(records, 205)
    assert.equal(writes.length, 3)
    assert.equal((writes.at(-1) as { offset: number }).offset, file.size)
    assert.equal((writes.at(-1) as { sequence: number }).sequence, 205)

    const replayWrites: unknown[] = []
    let replayed = 0
    for await (const _record of ingestCodexHistory(context(input.sessions, checkpoints, replayWrites))) {
      replayed += 1
    }
    assert.equal(replayed, 0)
    assert.equal(replayWrites.length, 0)
  } finally {
    await rm(input.root, { recursive: true, force: true })
  }
})

test('Codex 冷导入按最近活动时间优先并稳定回填旧文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-codex-order-'))
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
    assert.deepEqual(await codexHistoryInternals.listJsonlFiles(sessions), [
      recentBPath,
      recentAPath,
      oldPath,
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('中断消费时只推进到最后一个完整批次', async () => {
  const input = await fixture(codexHistoryInternals.CHECKPOINT_BATCH_SIZE + 1)
  const checkpoints = new Map<string, unknown>()
  const writes: unknown[] = []

  try {
    let records = 0
    for await (const _record of ingestCodexHistory(context(input.sessions, checkpoints, writes))) {
      records += 1
      if (records === codexHistoryInternals.CHECKPOINT_BATCH_SIZE + 1) break
    }

    assert.equal(records, 101)
    assert.equal(writes.length, 1)
    assert.equal((writes[0] as { sequence: number }).sequence, codexHistoryInternals.CHECKPOINT_BATCH_SIZE)
  } finally {
    await rm(input.root, { recursive: true, force: true })
  }
})
