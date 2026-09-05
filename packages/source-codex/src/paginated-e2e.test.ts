import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  DefaultCapabilityService,
  DefaultCoverageService,
  DefaultEvidenceService,
  DefaultIdentityService,
  DefaultObservationService,
} from '@agent-lens/core-services'
import { SourceHistoryRunner } from '@agent-lens/core-services/source-runner'
import { createTestCapturePolicy } from '@agent-lens/core-services/test-support'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { codexSourceDefinition, detectCodex } from './index'

async function prepareFixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-codex-paginated-'))
  const sessions = join(root, 'sessions')
  const target = join(sessions, '2026', '09', '05', 'rollout-paginated.jsonl')
  await mkdir(dirname(target), { recursive: true })
  const lines = [
    {
      timestamp: '2026-09-05T08:00:00.000Z',
      type: 'session_meta',
      payload: {
        session_id: 'thread-root', id: 'thread-root', timestamp: '2026-09-05T08:00:00.000Z',
        cwd: '/safe/project', originator: 'Codex', cli_version: 'current',
        source: 'vscode', thread_source: 'user', history_mode: 'paginated', model_provider: 'openai',
      },
    },
    {
      timestamp: '2026-09-05T08:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-1' },
    },
    {
      timestamp: '2026-09-05T08:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message', role: 'user',
        content: [{ type: 'input_text', text: '修复 Codex Paginated 解析' }],
      },
    },
    {
      timestamp: '2026-09-05T08:00:02.010Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed', thread_id: 'thread-root', turn_id: 'turn-1',
        item: {
          type: 'UserMessage', id: 'user-item-1', client_id: null,
          content: [{ type: 'text', text: '修复 Codex Paginated 解析', text_elements: [] }],
        },
        started_at_ms: 0, completed_at_ms: 1,
      },
    },
    {
      timestamp: '2026-09-05T08:00:03.000Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed', thread_id: 'thread-root', turn_id: 'turn-1',
        item: {
          type: 'Reasoning', id: 'reasoning-item-1',
          summary_text: ['先确认真实协议，再修改映射。'], raw_content: [],
        },
        started_at_ms: 2, completed_at_ms: 3,
      },
    },
    {
      timestamp: '2026-09-05T08:00:04.000Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed', thread_id: 'thread-root', turn_id: 'turn-1',
        item: {
          type: 'CommandExecution', id: 'command-item-1', command: ['npm', 'test'],
          cwd: '/safe/project', parsed_cmd: [], source: 'agent', status: 'completed',
          stdout: 'passed', stderr: null, aggregated_output: 'passed', exit_code: 0,
        },
        started_at_ms: 4, completed_at_ms: 5,
      },
    },
    {
      timestamp: '2026-09-05T08:00:05.000Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed', thread_id: 'thread-root', turn_id: 'turn-1',
        item: {
          type: 'AgentMessage', id: 'agent-item-1', phase: 'final_answer',
          content: [{ type: 'Text', text: '已经修复。' }],
        },
        started_at_ms: 6, completed_at_ms: 7,
      },
    },
    {
      timestamp: '2026-09-05T08:00:06.000Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-1' },
    },
  ]
  await writeFile(target, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`, 'utf8')
  return { root, sessions }
}

test('Paginated Codex history remains a user task and materializes visible conversation/tool nodes', async () => {
  const fixture = await prepareFixture()
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()

  try {
    const identity = new DefaultIdentityService(storage)
    const evidence = new DefaultEvidenceService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const capabilities = new DefaultCapabilityService()
    const coverage = new DefaultCoverageService(storage, evidence)
    const runner = new SourceHistoryRunner(
      storage,
      identity,
      observations,
      capabilities,
      coverage,
      createTestCapturePolicy(['codex']),
    )
    const host = await identity.resolveHost({
      name: 'codex-paginated-host', platform: process.platform, arch: process.arch,
    })
    const [detected] = await detectCodex({
      host,
      env: { CODEX_HOME: fixture.root, PATH: '' },
    })
    assert.ok(detected)

    const sync = await runner.sync({
      source: codexSourceDefinition,
      host,
      detected,
      abortSignal: new AbortController().signal,
    })
    const facts = await storage.repositories.observations.query({
      installationId: sync.installationId,
      limit: 100,
    })

    assert.equal(facts.filter(item => item.kind === 'message.user').length, 1)
    assert.equal(facts.filter(item => item.kind === 'message.assistant').length, 1)
    assert.equal(facts.filter(item => item.kind === 'message.reasoning').length, 1)
    assert.equal(facts.filter(item => item.kind === 'tool.call').length, 1)
    assert.equal(facts.filter(item => item.kind === 'tool.result').length, 1)
    assert.equal(facts.filter(item => item.kind === 'unknown').length, 0)

    const user = facts.find(item => item.kind === 'message.user')
    const assistant = facts.find(item => item.kind === 'message.assistant')
    assert.equal(user?.nativeEventId, 'user-item-1')
    assert.equal(assistant?.nativeEventId, 'agent-item-1')
    assert.equal((user?.payload as any).provenance.sourceSignal, 'event_msg.item_completed.UserMessage')
    assert.equal((assistant?.payload as any).provenance.sourceSignal, 'event_msg.item_completed.AgentMessage')

    const summaries = await storage.sessionSummaries.query({
      installationId: sync.installationId,
      limit: 10,
    })
    assert.equal(summaries.items.length, 1)
    const summary = summaries.items[0]!
    assert.equal(summary.userTurnCount, 1)
    assert.equal(summary.interactionCount, 1)
    assert.equal(summary.sessionActivity, 'user-task')
    assert.equal((summary.firstUserPayload as any)?.text, '修复 Codex Paginated 解析')
  } finally {
    storage.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
