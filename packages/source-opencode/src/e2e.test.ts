import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import {
  DefaultCapabilityService,
  DefaultCoverageService,
  DefaultEvidenceService,
  DefaultIdentityService,
  DefaultObservationService,
} from '@agent-lens/core-services'
import { SourceHistoryRunner, SourceRuntimeRunner } from '@agent-lens/core-services/source-runner'
import { createTestCapturePolicy } from '@agent-lens/core-services/test-support'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { detectOpenCode, openCodeSourceDefinition, openCodeSourceInternals } from './index'

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for OpenCode native-tail capture')
}

test('OpenCode Source reads native SQLite title/history and observes in-place part updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-opencode-'))
  const sourceRoot = join(root, 'opencode')
  const workspace = join(root, 'workspace')
  const dbPath = join(sourceRoot, 'opencode.db')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(sourceRoot, { recursive: true })
  await mkdir(workspace, { recursive: true })

  const nativeDb = new Database(dbPath)
  nativeDb.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, data TEXT);
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      session_id TEXT,
      time_created INTEGER,
      data TEXT
    );
  `)
  nativeDb.prepare('INSERT INTO session (id, directory, title) VALUES (?, ?, ?)').run('ses_1', workspace, 'OpenCode 原生会话标题')
  nativeDb.prepare('INSERT INTO message (id, data) VALUES (?, ?)').run('msg_old', JSON.stringify({ role: 'user' }))
  nativeDb.prepare('INSERT INTO message (id, data) VALUES (?, ?)').run('msg_u', JSON.stringify({ role: 'user' }))
  nativeDb.prepare('INSERT INTO message (id, data) VALUES (?, ?)').run('msg_a', JSON.stringify({ role: 'assistant', modelID: 'test-model' }))
  nativeDb.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)').run(
    'prt_old', 'msg_old', 'ses_1', 1_700_000_000_000, JSON.stringify({ type: 'text', text: '旧历史' }),
  )
  nativeDb.prepare('INSERT INTO session (id, directory, title) VALUES (?, ?, ?)').run('ses_latest', workspace, '最新会话')
  nativeDb.prepare('INSERT INTO message (id, data) VALUES (?, ?)').run('msg_latest', JSON.stringify({ role: 'user' }))
  nativeDb.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)').run(
    'prt_latest', 'msg_latest', 'ses_latest', 1_788_000_000_000, JSON.stringify({ type: 'text', text: '最新历史' }),
  )
  assert.deepEqual(
    openCodeSourceInternals.selectRows(nativeDb, 0, 100, Date.parse('2026-08-10T00:00:00.000Z'), 1)
      .map(row => row.session_id),
    ['ses_latest'],
  )
  nativeDb.prepare('DELETE FROM part WHERE session_id = ?').run('ses_latest')
  nativeDb.prepare('DELETE FROM message WHERE id = ?').run('msg_latest')
  nativeDb.prepare('DELETE FROM session WHERE id = ?').run('ses_latest')
  nativeDb.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)').run(
    'prt_text', 'msg_u', 'ses_1', 1_787_000_000_000, JSON.stringify({ type: 'text', text: '检查仓库' }),
  )
  nativeDb.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)').run(
    'prt_tool', 'msg_a', 'ses_1', 1_787_000_001_000,
    JSON.stringify({ type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'running', input: { command: 'git status' } } }),
  )

  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const evidence = new DefaultEvidenceService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const capabilities = new DefaultCapabilityService()
    const coverage = new DefaultCoverageService(storage, evidence)
    const capturePolicy = createTestCapturePolicy(['opencode'])
    const history = new SourceHistoryRunner(storage, identity, observations, capabilities, coverage, capturePolicy)
    const runtime = new SourceRuntimeRunner(storage, identity, observations, capabilities, coverage, capturePolicy)
    const host = await identity.resolveHost({ name: 'opencode-test-host' })
    const [detected] = await detectOpenCode({ host, env: { OPENCODE_HOME: sourceRoot } })
    assert.ok(detected)

    const historyResult = await history.sync({
      source: openCodeSourceDefinition,
      host,
      detected,
      abortSignal: new AbortController().signal,
      historyWindow: { activeSince: '2026-08-10T00:00:00.000Z' },
    })
    assert.equal(historyResult.records, 2)

    let facts = await storage.repositories.observations.query({ installationId: historyResult.installationId, limit: 50 })
    assert.equal(facts.filter(item => item.kind === 'message.user').length, 1)
    assert.equal(facts.filter(item => item.kind === 'tool.call').length, 1)
    assert.equal(facts.filter(item => item.kind === 'tool.result').length, 0)

    const logical = await storage.repositories.sessions.getLogicalSession(facts[0]!.logicalSessionId)
    assert.equal(logical?.title, 'OpenCode 原生会话标题')

    const controller = new AbortController()
    const handle = await runtime.start({ source: openCodeSourceDefinition, host, detected, abortSignal: controller.signal })
    try {
      nativeDb.prepare('UPDATE part SET data = ? WHERE id = ?').run(
        JSON.stringify({
          type: 'tool', callID: 'call_1', tool: 'bash',
          state: { status: 'completed', input: { command: 'git status' }, output: 'clean' },
        }),
        'prt_tool',
      )

      await waitFor(async () => {
        const results = await storage.repositories.observations.query({
          installationId: historyResult.installationId,
          kind: 'tool.result',
          limit: 10,
        })
        return results.length === 1
      })
    } finally {
      controller.abort()
      await handle.dispose()
    }

    facts = await storage.repositories.observations.query({ installationId: historyResult.installationId, limit: 50 })
    assert.equal(facts.filter(item => item.kind === 'tool.call').length, 1)
    assert.equal(facts.filter(item => item.kind === 'tool.result').length, 1)

    const coldHistory = await history.sync({
      source: openCodeSourceDefinition,
      host,
      detected,
      abortSignal: new AbortController().signal,
    })
    assert.equal(coldHistory.records, 3)

    const replay = await history.sync({
      source: openCodeSourceDefinition,
      host,
      detected,
      abortSignal: new AbortController().signal,
    })
    assert.equal(replay.records, 0)
  } finally {
    nativeDb.close()
    storage.close()
    await rm(root, { recursive: true, force: true })
  }
})
