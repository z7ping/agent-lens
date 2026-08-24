import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import {
  DefaultAssetService,
  DefaultCapabilityService,
  DefaultCoverageService,
  DefaultEvidenceService,
  DefaultIdentityService,
  DefaultObservationService,
} from '@agent-lens/core-services'
import {
  SourceAssetRunner,
  SourceHistoryRunner,
  SourceRuntimeRunner,
} from '@agent-lens/core-services/source-runner'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { detectHermes, hermesSourceDefinition } from './index'

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for Hermes runtime capture')
}

test('Hermes Source combines state.db history, assets and optional runtime-hook inbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-hermes-'))
  const hermesRoot = join(root, 'hermes')
  const workspace = join(root, 'workspace')
  const inbox = join(root, 'inbox')
  await mkdir(join(hermesRoot, 'skills', 'reviewer'), { recursive: true })
  await mkdir(workspace, { recursive: true })
  await mkdir(inbox, { recursive: true })
  await writeFile(join(hermesRoot, 'skills', 'reviewer', 'SKILL.md'), '# reviewer\n', 'utf8')
  await writeFile(join(hermesRoot, 'config.yaml'), 'mcp_servers:\n  docs:\n    command: node\ntoolsets:\n  - hermes-cli\n', 'utf8')

  const nativeDb = new Database(join(hermesRoot, 'state.db'))
  nativeDb.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT);
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      session_id TEXT,
      role TEXT,
      content TEXT,
      timestamp REAL,
      tool_calls TEXT,
      tool_call_id TEXT,
      tool_name TEXT
    );
  `)
  nativeDb.prepare('INSERT INTO sessions (id, cwd) VALUES (?, ?)').run('ses_1', workspace)
  nativeDb.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    1, 'ses_1', 'user', '检查项目', 1_787_000_000, null, null, null,
  )
  nativeDb.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    2, 'ses_1', 'assistant', '开始检查', 1_787_000_001,
    JSON.stringify([{ id: 'call_1', function: { name: 'terminal', arguments: JSON.stringify({ command: 'git status' }) } }]),
    null, null,
  )
  nativeDb.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    3, 'ses_1', 'tool', JSON.stringify({ exit_code: 0, output: 'clean' }), 1_787_000_002,
    null, 'call_1', 'terminal',
  )

  const previousInbox = process.env.AGENT_LENS_HERMES_INBOX
  process.env.AGENT_LENS_HERMES_INBOX = inbox
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const evidence = new DefaultEvidenceService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const capabilities = new DefaultCapabilityService()
    const coverage = new DefaultCoverageService(storage, evidence)
    const assets = new DefaultAssetService(storage)
    const history = new SourceHistoryRunner(storage, identity, observations, capabilities, coverage)
    const runtime = new SourceRuntimeRunner(storage, identity, observations, capabilities, coverage)
    const assetRunner = new SourceAssetRunner(storage, identity, capabilities, assets, evidence)
    const host = await identity.resolveHost({ name: 'hermes-test-host' })
    const [detected] = await detectHermes({ host, env: { HERMES_HOME: hermesRoot } })
    assert.ok(detected)

    const historyResult = await history.sync({
      source: hermesSourceDefinition,
      host,
      detected,
      abortSignal: new AbortController().signal,
    })
    assert.equal(historyResult.records, 3)

    let facts = await storage.repositories.observations.query({ installationId: historyResult.installationId, limit: 50 })
    assert.equal(facts.filter(item => item.kind === 'message.user').length, 1)
    assert.equal(facts.filter(item => item.kind === 'message.assistant').length, 1)
    assert.equal(facts.filter(item => item.kind === 'tool.call').length, 1)
    assert.equal(facts.filter(item => item.kind === 'tool.result').length, 1)

    const assetResult = await assetRunner.scan({
      source: hermesSourceDefinition,
      host,
      detected,
      abortSignal: new AbortController().signal,
    })
    assert.ok(assetResult.assetsDiscovered >= 3)

    const controller = new AbortController()
    const handle = await runtime.start({ source: hermesSourceDefinition, host, detected, abortSignal: controller.signal })
    try {
      const capturedAt = new Date().toISOString()
      await writeFile(join(inbox, 'runtime.json'), JSON.stringify({
        id: 'runtime-call-2',
        capturedAt,
        event: {
          hook_event_name: 'pre_tool_call',
          session_id: 'ses_1',
          tool_call_id: 'call_2',
          tool_name: 'terminal',
          args: { command: 'npm test' },
          cwd: workspace,
        },
      }), 'utf8')

      await waitFor(async () => {
        const calls = await storage.repositories.observations.query({
          installationId: historyResult.installationId,
          kind: 'tool.call',
          limit: 10,
        })
        return calls.length === 2
      })
    } finally {
      controller.abort()
      await handle.dispose()
    }

    facts = await storage.repositories.observations.query({ installationId: historyResult.installationId, limit: 50 })
    assert.equal(facts.filter(item => item.kind === 'tool.call').length, 2)

    const replay = await history.sync({
      source: hermesSourceDefinition,
      host,
      detected,
      abortSignal: new AbortController().signal,
    })
    assert.equal(replay.records, 0)
  } finally {
    if (previousInbox === undefined) delete process.env.AGENT_LENS_HERMES_INBOX
    else process.env.AGENT_LENS_HERMES_INBOX = previousInbox
    nativeDb.close()
    storage.close()
    await rm(root, { recursive: true, force: true })
  }
})
