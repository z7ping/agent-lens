import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
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
import { createTestCapturePolicy } from '@agent-lens/core-services/test-support'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import {
  claudeSourceDefinition,
  detectClaudeCode,
} from './index'

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for Claude runtime capture')
}

test('Claude Source covers history, assets and runtime reconciliation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-claude-'))
  const projects = join(root, 'projects', 'demo')
  const transcript = join(projects, 'session.jsonl')
  const cwd = join(root, 'workspace')
  const inbox = join(root, 'inbox')
  await mkdir(dirname(transcript), { recursive: true })
  await mkdir(cwd, { recursive: true })
  await mkdir(join(root, 'skills', 'reviewer'), { recursive: true })
  await writeFile(join(root, 'skills', 'reviewer', 'SKILL.md'), '# reviewer\n', 'utf8')
  await writeFile(join(root, 'settings.json'), JSON.stringify({
    mcpServers: { filesystem: { command: 'node' } },
    hooks: { PreToolUse: [{ hooks: [{ command: 'agent-lens' }] }] },
  }), 'utf8')

  const lines = [
    {
      type: 'user',
      sessionId: 'claude-session-1',
      uuid: 'user-1',
      timestamp: '2026-08-20T10:00:00.000Z',
      cwd,
      message: { content: 'inspect the repository' },
    },
    {
      type: 'assistant',
      sessionId: 'claude-session-1',
      uuid: 'assistant-1',
      timestamp: '2026-08-20T10:00:01.000Z',
      cwd,
      message: {
        content: [
          { type: 'text', text: 'I will inspect it.' },
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'git status' } },
        ],
      },
    },
    {
      type: 'user',
      sessionId: 'claude-session-1',
      uuid: 'result-1',
      timestamp: '2026-08-20T10:00:02.000Z',
      cwd,
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'clean', is_error: false }],
      },
    },
    {
      type: 'summary',
      sessionId: 'claude-session-1',
      uuid: 'summary-1',
      timestamp: '2026-08-20T10:00:03.000Z',
      cwd,
      summary: 'Repository inspected.',
    },
  ]
  await writeFile(transcript, `${lines.map(item => JSON.stringify(item)).join('\n')}\n`, 'utf8')

  const previousInbox = process.env.AGENT_LENS_CLAUDE_INBOX
  process.env.AGENT_LENS_CLAUDE_INBOX = inbox
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()

  try {
    const identity = new DefaultIdentityService(storage)
    const evidence = new DefaultEvidenceService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const capabilities = new DefaultCapabilityService()
    const coverage = new DefaultCoverageService(storage, evidence)
    const assets = new DefaultAssetService(storage)
    const capturePolicy = createTestCapturePolicy(['claude-code'])
    const history = new SourceHistoryRunner(storage, identity, observations, capabilities, coverage, capturePolicy)
    const assetRunner = new SourceAssetRunner(storage, identity, capabilities, assets, evidence, capturePolicy)
    const runtime = new SourceRuntimeRunner(storage, identity, observations, capabilities, coverage, capturePolicy)
    const host = await identity.resolveHost({ name: 'claude-test-host' })
    const [detected] = await detectClaudeCode({
      host,
      env: { CLAUDE_CODE_HOME: root, PATH: '' },
    })
    assert.ok(detected)

    const historyResult = await history.sync({
      source: claudeSourceDefinition,
      host,
      detected,
      abortSignal: new AbortController().signal,
    })
    assert.equal(historyResult.records, 4)

    let facts = await storage.repositories.observations.query({
      installationId: historyResult.installationId,
      limit: 100,
    })
    assert.equal(facts.length, 5)
    assert.equal(facts.filter(item => item.kind === 'tool.call').length, 1)
    assert.equal(facts.filter(item => item.kind === 'tool.result').length, 1)
    assert.equal(facts.filter(item => item.kind === 'context.summary').length, 1)

    const assetResult = await assetRunner.scan({
      source: claudeSourceDefinition,
      host,
      detected,
      abortSignal: new AbortController().signal,
    })
    assert.ok(assetResult.assetsDiscovered >= 3)

    await mkdir(inbox, { recursive: true })
    await writeFile(join(inbox, 'runtime.json'), JSON.stringify({
      id: 'runtime-tool-1',
      capturedAt: '2026-08-20T10:00:01.500Z',
      event: {
        hook_event_name: 'PreToolUse',
        session_id: 'claude-session-1',
        tool_use_id: 'tool-1',
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
        cwd,
        timestamp: '2026-08-20T10:00:01.000Z',
      },
    }), 'utf8')

    const runtimeController = new AbortController()
    const handle = await runtime.start({
      source: claudeSourceDefinition,
      host,
      detected,
      abortSignal: runtimeController.signal,
    })
    try {
      await waitFor(async () => {
        const toolCalls = (await storage.repositories.observations.query({
          installationId: historyResult.installationId,
          kind: 'tool.call',
          limit: 10,
        }))
        return toolCalls.length === 1 && (toolCalls[0]?.evidenceRefs.length ?? 0) === 2
      })
    } finally {
      runtimeController.abort()
      await handle.dispose()
    }

    facts = await storage.repositories.observations.query({
      installationId: historyResult.installationId,
      limit: 100,
    })
    assert.equal(facts.filter(item => item.kind === 'tool.call').length, 1)
    const toolCall = facts.find(item => item.kind === 'tool.call')
    assert.equal(toolCall?.evidenceRefs.length, 2)

    const replay = await history.sync({
      source: claudeSourceDefinition,
      host,
      detected,
      abortSignal: new AbortController().signal,
    })
    assert.equal(replay.records, 0)
  } finally {
    storage.close()
    if (previousInbox === undefined) delete process.env.AGENT_LENS_CLAUDE_INBOX
    else process.env.AGENT_LENS_CLAUDE_INBOX = previousInbox
    await rm(root, { recursive: true, force: true })
  }
})
