import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SourceRecord } from '@agent-lens/core'
import { codexHistoryInternals } from './history'
import { normalizeCodexRecord } from './normalize'

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

  const normalized = await normalizeCodexRecord(record, {} as never)
  assert.equal(normalized.observations[0]?.identityHints.sessionTitle, 'Codex 原生线程摘要')
  assert.equal(normalized.observations[0]?.kind, 'session.lifecycle')
})
