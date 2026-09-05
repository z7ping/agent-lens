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

function completedItem(timestamp: string, item: Record<string, unknown>, startedAtMs: number) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'item_completed', thread_id: 'thread-root', turn_id: 'turn-1', item,
      started_at_ms: startedAtMs, completed_at_ms: startedAtMs + 1,
    },
  }
}

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
    completedItem('2026-09-05T08:00:02.010Z', {
      type: 'UserMessage', id: 'user-item-1', client_id: null,
      content: [{ type: 'text', text: '修复 Codex Paginated 解析', text_elements: [] }],
    }, 0),
    completedItem('2026-09-05T08:00:02.100Z', {
      type: 'HookPrompt', id: 'hook-item-1',
      fragments: [{ text: 'Injected by project hook', hookRunId: 'hook-run-1' }],
    }, 2),
    completedItem('2026-09-05T08:00:02.200Z', {
      type: 'Plan', id: 'plan-item-1', text: '先确认协议，再完成映射。',
    }, 4),
    completedItem('2026-09-05T08:00:03.000Z', {
      type: 'Reasoning', id: 'reasoning-item-1',
      summary_text: ['先确认真实协议，再修改映射。'], raw_content: [],
    }, 6),
    completedItem('2026-09-05T08:00:04.000Z', {
      type: 'CommandExecution', id: 'command-item-1', command: ['npm', 'test'],
      cwd: '/safe/project', parsed_cmd: [], source: 'agent', status: 'completed',
      stdout: 'passed', stderr: null, aggregated_output: 'passed', exit_code: 0,
    }, 8),
    completedItem('2026-09-05T08:00:04.100Z', {
      type: 'FunctionCallOutput', id: 'function-output-1', name: 'read_file',
      namespace: 'workspace', output: { text: 'file content' },
    }, 10),
    completedItem('2026-09-05T08:00:04.200Z', {
      type: 'SubAgentActivity', id: 'subagent-start-1', kind: 'started',
      agent_thread_id: 'thread-child', agent_path: ['worker'],
    }, 12),
    completedItem('2026-09-05T08:00:04.300Z', {
      type: 'SubAgentActivity', id: 'subagent-interacted-1', kind: 'interacted',
      agent_thread_id: 'thread-child', agent_path: ['worker'],
    }, 14),
    completedItem('2026-09-05T08:00:04.400Z', {
      type: 'SubAgentActivity', id: 'subagent-end-1', kind: 'completed',
      agent_thread_id: 'thread-child', agent_path: ['worker'],
    }, 16),
    completedItem('2026-09-05T08:00:04.500Z', {
      type: 'EnteredReviewMode', id: 'review-entered-1',
      target: { type: 'uncommittedChanges' }, user_facing_hint: '正在审查改动',
    }, 18),
    completedItem('2026-09-05T08:00:04.600Z', {
      type: 'FileChange', id: 'file-change-1',
      changes: { 'src/example.ts': { type: 'update', unified_diff: '@@ -1 +1 @@' } },
      status: 'completed', auto_approved: true, stdout: null, stderr: null,
    }, 20),
    completedItem('2026-09-05T08:00:04.700Z', {
      type: 'ExitedReviewMode', id: 'review-exited-1', review_output: { findings: [] },
    }, 22),
    completedItem('2026-09-05T08:00:05.000Z', {
      type: 'AgentMessage', id: 'agent-item-1', phase: 'final_answer',
      content: [{ type: 'Text', text: '已经修复。' }],
    }, 24),
    {
      timestamp: '2026-09-05T08:00:06.000Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-1' },
    },
  ]
  await writeFile(target, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`, 'utf8')
  return { root, sessions }
}

test('Paginated Codex history remains one real user task while native non-conversation items stay structured', async () => {
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
    assert.equal(facts.filter(item => item.kind === 'message.commentary').length, 1)
    assert.equal(facts.filter(item => item.kind === 'message.reasoning').length, 1)
    assert.equal(facts.filter(item => item.kind === 'context.injected').length, 1)
    assert.equal(facts.filter(item => item.kind === 'tool.call').length, 1)
    assert.equal(facts.filter(item => item.kind === 'tool.result').length, 2)
    assert.equal(facts.filter(item => item.kind === 'subagent.spawn').length, 1)
    assert.equal(facts.filter(item => item.kind === 'subagent.end').length, 1)
    assert.equal(facts.filter(item => item.kind === 'artifact.action').length, 1)
    assert.equal(facts.filter(item => item.kind === 'unknown').length, 0)

    const lifecycleEvents = facts
      .filter(item => item.kind === 'session.lifecycle')
      .map(item => (item.payload as any).event)
    assert.ok(lifecycleEvents.includes('subagent.interacted'))
    assert.ok(lifecycleEvents.includes('review.entered'))
    assert.ok(lifecycleEvents.includes('review.exited'))

    const user = facts.find(item => item.kind === 'message.user')
    const assistant = facts.find(item => item.kind === 'message.assistant')
    const plan = facts.find(item => item.kind === 'message.commentary')
    const hook = facts.find(item => item.kind === 'context.injected')
    assert.equal(user?.nativeEventId, 'user-item-1')
    assert.equal(assistant?.nativeEventId, 'agent-item-1')
    assert.equal(plan?.nativeEventId, 'plan-item-1')
    assert.equal(hook?.nativeEventId, 'hook-item-1')
    assert.equal((user?.payload as any).provenance.sourceSignal, 'event_msg.item_completed.UserMessage')
    assert.equal((assistant?.payload as any).provenance.sourceSignal, 'event_msg.item_completed.AgentMessage')
    assert.equal((plan?.payload as any).provenance.sourceSignal, 'event_msg.item_completed.Plan')
    assert.equal((hook?.payload as any).provenance.actualAuthor, 'application')

    const summaries = await storage.sessionSummaries.query({
      installationId: sync.installationId,
      limit: 10,
    })
    assert.equal(summaries.items.length, 1)
    const summary = summaries.items[0]!
    assert.equal(summary.userTurnCount, 1)
    assert.equal(summary.interactionCount, 1)
    assert.equal(summary.systemContextCount, 1)
    assert.equal(summary.toolCount, 2)
    assert.equal(summary.sessionActivity, 'user-task')
    assert.equal((summary.firstUserPayload as any)?.text, '修复 Codex Paginated 解析')
  } finally {
    await storage.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
