import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SourceRecord } from '@agent-lens/core'
import { codexHistoryInternals } from './history'
import { normalizeCodexRecord } from './normalize'
import { codexTestContext } from './test-support'

test('Codex session index uses the latest native thread_name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-codex-index-'))
  try {
    await writeFile(join(root, 'session_index.jsonl'), [
      JSON.stringify({ id: 'session-1', thread_name: '旧标题', updated_at: '2026-08-20T01:00:00.000Z' }),
      JSON.stringify({ id: 'session-1', thread_name: 'Codex 原生线程摘要', updated_at: '2026-08-20T02:00:00.000Z' }),
      '{bad-json',
    ].join('\n'))

    const names = await codexHistoryInternals.readThreadNames(root)
    assert.deepEqual(names.get('session-1'), {
      title: 'Codex 原生线程摘要',
      updatedAt: '2026-08-20T02:00:00.000Z',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Codex session_meta payload timestamp is the real session start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-codex-meta-'))
  try {
    const file = join(root, 'rollout-session-1.jsonl')
    await writeFile(file, JSON.stringify({
      timestamp: '2026-08-20T01:05:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'session-1',
        timestamp: '2026-08-20T01:00:00.000Z',
        cwd: 'C:\\work\\agent-lens',
        cli_version: '1.0.0',
      },
    }) + '\n')

    const metadata = await codexHistoryInternals.readSessionMetadata(file, {
      title: 'Codex 原生线程摘要',
    })
    assert.equal(metadata.nativeSessionId, 'session-1')
    assert.equal(metadata.startedAt, '2026-08-20T01:00:00.000Z')
    assert.equal(metadata.title, 'Codex 原生线程摘要')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Codex native title becomes sessionTitle identity metadata', async () => {
  const record: SourceRecord = {
    id: 'codex-session-title-record',
    sourceId: 'codex',
    installationId: 'installation-codex',
    sourceSessionNativeId: 'session-1',
    nativeType: 'metadata/session_title',
    nativeId: 'session-title:session-1',
    capturedAt: '2026-08-20T02:00:00.000Z',
    locator: { kind: 'file', path: 'C:\\Users\\test\\.codex\\session_index.jsonl' },
    fingerprint: 'title-fingerprint',
    parserVersion: '2',
    payload: {
      entry: {
        type: 'session_title',
        payload: { title: 'Codex 原生线程摘要' },
      },
      session: {
        nativeSessionId: 'session-1',
        title: 'Codex 原生线程摘要',
      },
    },
  }

  const normalized = await normalizeCodexRecord(record, codexTestContext)
  assert.equal(normalized.observations[0]?.identityHints.sessionTitle, 'Codex 原生线程摘要')
  assert.equal(normalized.observations[0]?.identityHints.sessionTitleKind, 'unverified')
  assert.equal(normalized.observations[0]?.kind, 'session.lifecycle')
})

test('Codex verified SQLite title is carried into canonical identity', async () => {
  const record: SourceRecord = {
    id: 'verified-title', sourceId: 'codex', installationId: 'installation-codex',
    sourceSessionNativeId: 'verified-session', nativeType: 'metadata/session_title',
    capturedAt: '2026-08-20T02:00:00.000Z', fingerprint: 'verified-fingerprint',
    locator: { kind: 'file', path: 'state_5.sqlite' },
    payload: { entry: { type: 'session_title', payload: { title: '可信摘要' } }, session: { nativeSessionId: 'verified-session', title: '可信摘要', titleKind: 'generated' } },
    parserVersion: '12',
  }
  const normalized = await normalizeCodexRecord(record, codexTestContext)
  assert.equal(normalized.observations[0]?.identityHints.sessionTitleKind, 'generated')
})

test('Codex native SQLite generated title is read when the index is absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-codex-sqlite-'))
  try {
    const db = new DatabaseSync(join(root, 'state_5.sqlite'))
    try {
      db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, updated_at INTEGER)')
      db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('sqlite-only', 'Codex 自动生成的任务标题', 1780000000)
    } finally { db.close() }
    const titles = await codexHistoryInternals.readThreadNames(root)
    assert.equal(titles.get('sqlite-only')?.title, 'Codex 自动生成的任务标题')
    assert.equal(titles.get('sqlite-only')?.source, 'sqlite')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Codex trusted SQLite title is preferred to unverified newer index, not index append order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-codex-title-priority-'))
  try {
    await writeFile(join(root, 'session_index.jsonl'), [
      JSON.stringify({ id: 'sqlite-wins', thread_name: '初始用户输入', updated_at: '2026-08-01T00:00:00Z' }),
      JSON.stringify({ id: 'index-wins', thread_name: '最新重命名标题', updated_at: '2026-09-01T00:00:00Z' }),
      JSON.stringify({ id: 'sqlite-wins', thread_name: '过期索引尾部', updated_at: '2026-07-01T00:00:00Z' }),
    ].join('\n'))
    const db = new DatabaseSync(join(root, 'state_5.sqlite'))
    try {
      db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, updated_at INTEGER)')
      db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('sqlite-wins', '原生生成的摘要标题', Date.parse('2026-08-15T00:00:00Z') / 1000)
      db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('index-wins', '较早数据库标题', Date.parse('2026-08-15T00:00:00Z') / 1000)
    } finally { db.close() }
    const titles = await codexHistoryInternals.readThreadNames(root)
    assert.equal(titles.get('sqlite-wins')?.title, '原生生成的摘要标题')
    assert.equal(titles.get('index-wins')?.title, '较早数据库标题')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Codex title index remains usable when native SQLite schema differs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-codex-legacy-sqlite-'))
  try {
    await writeFile(join(root, 'session_index.jsonl'), JSON.stringify({
      id: 'legacy', thread_name: '索引回退标题', updated_at: '2026-08-01T00:00:00Z',
    }))
    const db = new DatabaseSync(join(root, 'state_5.sqlite'))
    try { db.exec('CREATE TABLE something_else (id TEXT)') } finally { db.close() }
    const titles = await codexHistoryInternals.readThreadNames(root)
    assert.equal(titles.get('legacy')?.title, '索引回退标题')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
