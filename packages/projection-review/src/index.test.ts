import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DefaultIdentityService,
  DefaultObservationService,
} from '@agent-lens/core-services'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { ReviewProjection, reviewProjectionInternals } from './index'

test('ReviewProjection builds task summaries and interaction tool status from canonical facts', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'review-projection-host' })
    const installation = await identity.resolveInstallation({
      hostId: host.id,
      productId: 'codex',
    })

    const add = async (
      kind: 'message.user' | 'message.assistant' | 'message.commentary' | 'tool.call' | 'tool.result',
      nativeEventId: string,
      at: string,
      payload: unknown,
    ) => observations.commit({
      sourceId: 'codex',
      host,
      installation,
      candidate: {
        kind,
        nativeEventId,
        occurredAt: at,
        capturedAt: at,
        payload,
        identityHints: {
          nativeSessionId: 'review-session-1',
          workspacePath: '/tmp/agent-lens',
        },
        dedupHints: { nativeEventId },
      },
      evidenceCandidates: [{
        captureMethod: 'native-log',
        derivation: 'reported',
        nativeStableId: nativeEventId,
        capturedAt: at,
      }],
    })

    const user = await add('message.user', 'user-1', '2026-08-21T01:00:00.000Z', { text: '修复登录问题' })
    await add('message.commentary', 'assistant-1', '2026-08-21T01:00:01.000Z', { text: '开始检查', phase: 'commentary' })
    await add('tool.call', 'call-1', '2026-08-21T01:00:02.000Z', {
      callId: 'tool-call-1', nativeToolName: 'bash', input: { command: 'npm test' },
    })
    await add('tool.result', 'result-1', '2026-08-21T01:00:03.000Z', {
      callId: 'tool-call-1', success: false, durationMs: 800, output: 'failed',
    })

    const projection = new ReviewProjection(storage)
    const response = await projection.query({ status: 'with-errors' })
    assert.equal(response.items.length, 1)
    const summary = response.items[0]!
    assert.equal(summary.id, user.observation.logicalSessionId)
    assert.equal(summary.preview, '修复登录问题')
    assert.equal(summary.userTurnCount, 1)
    assert.equal(summary.systemContextCount, 0)
    assert.equal(summary.sessionActivity, 'user-task')
    assert.equal(summary.toolCount, 1)
    assert.equal(summary.errorCount, 1)
    assert.equal(summary.hasErrors, true)

    const detail = await projection.get(summary.id)
    assert.ok(detail)
    assert.equal(detail.interactions.length, 1)
    const commentary = detail.interactions[0]?.nodes.find(node => node.type === 'message' && node.text === '开始检查')
    assert.equal(commentary?.type, 'message')
    if (commentary?.type === 'message') assert.equal(commentary.role, 'commentary')
    const tool = detail.interactions[0]?.nodes.find(node => node.type === 'tool')
    assert.equal(tool?.type, 'tool')
    if (tool?.type === 'tool') {
      assert.equal(tool.name, 'bash')
      assert.equal(tool.status, 'error')
      assert.equal(tool.durationMs, 800)
      assert.equal(tool.observationIds.length, 2)
    }
  } finally {
    storage.close()
  }
})

test('ReviewProjection renders an orphan tool result as a completed Tool node', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'review-orphan-tool-host' })
    const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'codex' })
    const common = {
      sourceId: 'codex', host, installation,
      evidenceCandidates: [],
    }
    const user = await observations.commit({
      ...common,
      candidate: {
        kind: 'message.user',
        nativeEventId: 'orphan-tool-user',
        occurredAt: '2026-09-05T10:00:00.000Z',
        capturedAt: '2026-09-05T10:00:00.000Z',
        payload: { text: '读取文件' },
        identityHints: { nativeSessionId: 'orphan-tool-session' },
        dedupHints: { nativeEventId: 'orphan-tool-user' },
      },
    })
    await observations.commit({
      ...common,
      candidate: {
        kind: 'tool.result',
        nativeEventId: 'orphan-tool-result',
        occurredAt: '2026-09-05T10:00:01.000Z',
        capturedAt: '2026-09-05T10:00:01.000Z',
        payload: {
          callId: 'function-output-1',
          nativeToolName: 'read_file',
          success: true,
          durationMs: 12,
          output: 'file content',
        },
        identityHints: { nativeSessionId: 'orphan-tool-session' },
        dedupHints: { nativeEventId: 'orphan-tool-result' },
      },
    })

    const detail = await new ReviewProjection(storage).get(user.observation.logicalSessionId)
    assert.ok(detail)
    const node = detail.interactions[0]?.nodes.find(item => item.id === 'orphan-tool-result' || item.observationIds.includes(user.observation.id) === false && item.type === 'tool')
    assert.equal(node?.type, 'tool')
    if (node?.type === 'tool') {
      assert.equal(node.name, 'read_file')
      assert.equal(node.callId, 'function-output-1')
      assert.equal(node.status, 'success')
      assert.equal(node.durationMs, 12)
      assert.equal(node.output, 'file content')
      assert.equal(node.startedAt, node.endedAt)
      assert.equal(node.observationIds.length, 1)
    }
  } finally {
    storage.close()
  }
})

test('ReviewProjection omits preview when the first user message has no displayable text', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'review-preview-host' })
    const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'pi' })
    await observations.commit({
      sourceId: 'pi',
      host,
      installation,
      candidate: {
        kind: 'message.user',
        nativeEventId: 'empty-user',
        occurredAt: '2026-08-21T02:00:00.000Z',
        capturedAt: '2026-08-21T02:00:00.000Z',
        payload: {},
        identityHints: { nativeSessionId: 'empty-preview-session' },
        dedupHints: { nativeEventId: 'empty-user' },
      },
      evidenceCandidates: [],
    })

    const response = await new ReviewProjection(storage).query()
    assert.equal(response.items.length, 1)
    assert.equal('preview' in response.items[0]!, false)
  } finally {
    storage.close()
  }
})

test('ReviewProjection summary list uses the optimized session summary reader', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'review-batch-host' })
    const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'codex' })
    for (let index = 0; index < 3; index += 1) {
      const at = `2026-08-21T03:00:0${index}.000Z`
      await observations.commit({
        sourceId: 'codex',
        host,
        installation,
        candidate: {
          kind: 'message.user',
          nativeEventId: `batch-user-${index}`,
          occurredAt: at,
          capturedAt: at,
          payload: { text: `任务 ${index}` },
          identityHints: { nativeSessionId: `batch-session-${index}` },
          dedupHints: { nativeEventId: `batch-user-${index}` },
        },
        evidenceCandidates: [],
      })
    }

    const originalQuery = storage.repositories.observations.query.bind(
      storage.repositories.observations,
    )
    let perSessionQueries = 0
    let batchedQueries = 0
    storage.repositories.observations.query = async query => {
      if (query.logicalSessionId) perSessionQueries += 1
      if (query.logicalSessionIds?.length) batchedQueries += 1
      return originalQuery(query)
    }

    const response = await new ReviewProjection(storage).query()

    assert.equal(response.items.length, 3)
    assert.equal(perSessionQueries, 0)
    assert.equal(batchedQueries, 0)
  } finally {
    storage.close()
  }
})

test('ReviewProjection localizes real lifecycle actions instead of collapsing them to one title', () => {
  const label = reviewProjectionInternals.lifecycleEventLabel
  assert.equal(label({ event: 'session.started' }), '会话开始')
  assert.equal(label({ event: 'session.resumed' }), '恢复会话')
  assert.equal(label({ event: 'session.discovered' }), '发现会话')
  assert.equal(label({ event: 'session.ended' }), '会话结束')
  assert.equal(label({ event: 'turn.completed' }), '轮次结束')
  assert.equal(label({ event: 'turn.stopped' }), '轮次停止')
  assert.equal(label({ event: 'turn.aborted' }), '轮次终止')
  assert.equal(label({ event: 'turn.error' }), '轮次错误')
  assert.equal(label({ event: 'review.entered' }), '进入审查')
  assert.equal(label({ event: 'review.exited' }), '退出审查')
  assert.equal(label({ event: 'subagent.interacted' }), '子 Agent 活动')
  assert.equal(label({ event: 'subagent.communication' }), '子 Agent 通信')
  assert.equal(label({ event: 'reasoning.configuration.updated' }), '推理配置更新')
  assert.equal(label({ action: 'session_interrupted' }), '会话中断')
  assert.equal(label({ event: 'vendor.future.lifecycle' }), '会话状态变化')
})
