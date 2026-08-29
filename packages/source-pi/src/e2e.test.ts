import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import { detectPi, piSourceDefinition } from './index'

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for Pi native tail capture')
}

test('Pi Source covers history, assets and native-tail runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-'))
  const agentDir = join(root, 'agent')
  const transcript = join(agentDir, 'sessions', 'demo', 'session.jsonl')
  const cwd = join(root, 'workspace')
  await mkdir(dirname(transcript), { recursive: true })
  await mkdir(cwd, { recursive: true })
  await mkdir(join(agentDir, 'skills', 'reviewer'), { recursive: true })
  await mkdir(join(agentDir, 'extensions', 'trace-ext'), { recursive: true })
  await writeFile(join(agentDir, 'skills', 'reviewer', 'SKILL.md'), '# reviewer\n', 'utf8')
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    mcpServers: { docs: { command: 'node' } },
  }), 'utf8')

  const lines = [
    {
      type: 'session',
      id: 'pi-session-1',
      cwd,
      version: '1.0.0',
      timestamp: '2026-08-20T11:00:00.000Z',
    },
    {
      type: 'message',
      id: 'pi-user-1',
      parentId: null,
      timestamp: '2026-08-20T11:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'inspect the repository' }] },
    },
    {
      type: 'message',
      id: 'pi-assistant-1',
      parentId: 'pi-user-1',
      timestamp: '2026-08-20T11:00:02.000Z',
      message: {
        role: 'assistant',
        provider: 'test',
        model: 'test-model',
        content: [
          { type: 'text', text: 'I will inspect it.' },
          { type: 'toolCall', id: 'pi-tool-1', name: 'bash', arguments: { command: 'git status' } },
        ],
      },
    },
    {
      type: 'message',
      id: 'pi-result-1',
      parentId: 'pi-assistant-1',
      timestamp: '2026-08-20T11:00:03.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'pi-tool-1',
        toolName: 'bash',
        isError: false,
        content: [{ type: 'text', text: 'clean' }],
      },
    },
    {
      type: 'model_change',
      id: 'pi-model-1',
      timestamp: '2026-08-20T11:00:04.000Z',
      provider: 'test',
      modelId: 'test-model-2',
    },
    {
      type: 'thinking_level_change',
      id: 'pi-thinking-level-1',
      timestamp: '2026-08-20T11:00:05.000Z',
      level: 'high',
    },
    {
      type: 'compaction',
      id: 'pi-compact-1',
      timestamp: '2026-08-20T11:00:06.000Z',
      summary: 'compact summary',
      tokensBefore: 1234,
    },
  ]
  await writeFile(transcript, `${lines.map(item => JSON.stringify(item)).join('\n')}\n`, 'utf8')

  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const evidence = new DefaultEvidenceService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const capabilities = new DefaultCapabilityService()
    const coverage = new DefaultCoverageService(storage, evidence)
    const assets = new DefaultAssetService(storage)
    const capturePolicy = createTestCapturePolicy(['pi'])
    const history = new SourceHistoryRunner(storage, identity, observations, capabilities, coverage, capturePolicy)
    const assetRunner = new SourceAssetRunner(storage, identity, capabilities, assets, evidence, capturePolicy)
    const runtime = new SourceRuntimeRunner(storage, identity, observations, capabilities, coverage, capturePolicy)
    const host = await identity.resolveHost({ name: 'pi-test-host' })
    const [detected] = await detectPi({
      host,
      env: { PI_CODING_AGENT_DIR: agentDir, PATH: '' },
    })
    assert.ok(detected)

    const historyResult = await history.sync({
      source: piSourceDefinition,
      host,
      detected,
      abortSignal: new AbortController().signal,
    })
    assert.equal(historyResult.records, 7)

    let facts = await storage.repositories.observations.query({
      installationId: historyResult.installationId,
      limit: 100,
    })
    assert.equal(facts.length, 8)
    assert.equal(facts.filter(item => item.kind === 'tool.call').length, 1)
    assert.equal(facts.filter(item => item.kind === 'tool.result').length, 1)
    assert.equal(facts.filter(item => item.kind === 'model.changed').length, 1)
    assert.equal(facts.filter(item => item.kind === 'thinking.level.changed').length, 1)
    assert.equal(facts.filter(item => item.kind === 'context.compaction').length, 1)

    const assetResult = await assetRunner.scan({
      source: piSourceDefinition,
      host,
      detected,
      abortSignal: new AbortController().signal,
    })
    assert.ok(assetResult.assetsDiscovered >= 3)

    const runtimeController = new AbortController()
    const handle = await runtime.start({
      source: piSourceDefinition,
      host,
      detected,
      abortSignal: runtimeController.signal,
    })
    try {
      await appendFile(transcript, `${JSON.stringify({
        type: 'message',
        id: 'pi-user-2',
        parentId: 'pi-result-1',
        timestamp: '2026-08-20T11:00:07.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      })}\n`, 'utf8')

      await waitFor(async () => {
        const messages = await storage.repositories.observations.query({
          installationId: historyResult.installationId,
          kind: 'message.user',
          limit: 20,
        })
        return messages.length === 2
      })
    } finally {
      runtimeController.abort()
      await handle.dispose()
    }

    facts = await storage.repositories.observations.query({
      installationId: historyResult.installationId,
      limit: 100,
    })
    assert.equal(facts.filter(item => item.kind === 'message.user').length, 2)

    const replay = await history.sync({
      source: piSourceDefinition,
      host,
      detected,
      abortSignal: new AbortController().signal,
    })
    assert.equal(replay.records, 0)
  } finally {
    storage.close()
    await rm(root, { recursive: true, force: true })
  }
})
