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
    await add('message.assistant', 'assistant-final', '2026-08-21T01:00:04.000Z', { text: '已完成检查' })

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

    const summaryDetail = await projection.get(summary.id, { process: 'summary' })
    assert.ok(summaryDetail)
    const interaction = summaryDetail.interactions[0]!
    assert.equal(interaction.processSummary?.messageCount, 1)
    assert.equal(interaction.processSummary?.toolCount, 1)
    assert.equal(interaction.processSummary?.errorCount, 1)
    assert.equal(interaction.processSummary?.availability, 'available')
    assert.equal(interaction.nodes.some(node => node.type === 'message' && node.role === 'commentary'), false)
    assert.equal(interaction.nodes.some(node => node.type === 'tool'), false)
    assert.equal(interaction.nodes.some(node => node.type === 'message' && node.role === 'user'), true)
    assert.equal(interaction.nodes.some(node => node.type === 'message' && node.role === 'assistant'), true)
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

test('ReviewProjection 默认不把独立运行时启动审计列为任务', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'review-runtime-startup-host' })
    const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'pi' })
    const audit = await observations.commit({
      sourceId: 'pi', host, installation,
      candidate: {
        kind: 'runtime.startup', nativeEventId: 'review-runtime-startup',
        occurredAt: '2026-09-17T00:00:00.000Z', capturedAt: '2026-09-17T00:00:00.000Z',
        payload: { event: 'runtime.startup.audit' },
        identityHints: { nativeSessionId: 'review-runtime-startup' },
        dedupHints: { nativeEventId: 'review-runtime-startup' },
      },
      evidenceCandidates: [],
    })

    const projection = new ReviewProjection(storage)
    assert.deepEqual((await projection.query()).items, [])
    const included = await projection.query({ includeSystemActivity: true })
    assert.deepEqual(included.items.map(item => [item.id, item.sessionActivity]), [[audit.observation.logicalSessionId, 'system-activity']])
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


test('Review process=summary uses headers plus batch hydration instead of full interaction reads', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'review-process-summary-host' })
    const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'codex' })
    const common = {
      sourceId: 'codex',
      host,
      installation,
      evidenceCandidates: [],
    }
    const add = async (
      kind: 'message.user' | 'message.assistant' | 'message.commentary' | 'message.reasoning' | 'tool.call' | 'tool.result' | 'model.changed' | 'session.lifecycle',
      nativeEventId: string,
      at: string,
      payload: unknown,
    ) => observations.commit({
      ...common,
      candidate: {
        kind,
        nativeEventId,
        occurredAt: at,
        capturedAt: at,
        payload,
        identityHints: { nativeSessionId: 'review-process-summary-session' },
        dedupHints: { nativeEventId },
      },
    })

    const user = await add('message.user', 'summary-user', '2026-09-20T00:00:00.000Z', { text: '检查项目' })
    await add('message.commentary', 'summary-commentary', '2026-09-20T00:00:01.000Z', { text: '正在检查'.repeat(2000) })
    await add('tool.call', 'summary-tool-call', '2026-09-20T00:00:02.000Z', {
      callId: 'summary-tool', nativeToolName: 'bash', input: { command: 'npm test' },
    })
    await add('tool.result', 'summary-tool-result', '2026-09-20T00:00:03.000Z', {
      callId: 'summary-tool', success: false, output: 'x'.repeat(100_000),
    })
    await add('model.changed', 'summary-model', '2026-09-20T00:00:04.000Z', {
      provider: 'openai', model: 'gpt-5.6',
    })
    for (let index = 0; index < 80; index += 1) {
      await add(
        'session.lifecycle',
        `summary-lifecycle-${index}`,
        new Date(Date.parse('2026-09-20T00:00:05.000Z') + index * 1_000).toISOString(),
        { event: 'review.progress', index },
      )
    }
    await add('message.assistant', 'summary-final', '2026-09-20T00:02:00.000Z', { text: '检查完成' })
    await add('session.lifecycle', 'summary-terminal', '2026-09-20T00:02:01.000Z', { event: 'turn.completed' })

    const repository = storage.repositories.observations
    const originalQuery = repository.query.bind(repository)
    const originalHeaders = repository.queryHeaders?.bind(repository)
    const originalGetMany = repository.getMany?.bind(repository)
    let fullQueries = 0
    let headerQueries = 0
    let batchReads = 0
    let batchHydratedIds = 0
    repository.query = async query => {
      if (query.logicalSessionId === user.observation.logicalSessionId) fullQueries += 1
      return originalQuery(query)
    }
    if (originalHeaders) repository.queryHeaders = async query => {
      if (query.logicalSessionId === user.observation.logicalSessionId) headerQueries += 1
      return originalHeaders(query)
    }
    if (originalGetMany) repository.getMany = async ids => {
      batchReads += 1
      batchHydratedIds += ids.length
      return originalGetMany(ids)
    }

    const projection = new ReviewProjection(storage)
    const summary = await projection.get(user.observation.logicalSessionId, {
      direction: 'backward',
      limit: 1,
      process: 'summary',
    })
    assert.ok(summary)
    assert.equal(fullQueries, 0)
    assert.ok(headerQueries > 0)
    assert.ok(batchReads > 0)
    assert.ok(batchHydratedIds < 12, `expected only display facts to hydrate, got ${batchHydratedIds}`)

    const round = summary.interactions[0]!
    assert.equal(round.processMode, 'summary')
    assert.equal(round.processSummary?.messageCount, 1)
    assert.equal(round.processSummary?.toolCount, 1)
    assert.equal(round.processSummary?.errorCount, 1)
    assert.equal(round.nodes.some(node => node.type === 'tool'), false)
    assert.equal(round.nodes.some(node => node.type === 'message' && node.role === 'commentary'), false)
    assert.equal(round.nodes.some(node => node.type === 'event' && node.kind === 'model.changed'), true)
    assert.equal(round.nodes.some(node => node.type === 'message' && node.role === 'assistant' && node.text === '检查完成'), true)
    assert.equal(round.nodes.some(node => node.type === 'event' && node.kind === 'session.lifecycle'), true)

    const full = await projection.get(user.observation.logicalSessionId, { ordinal: 1, process: 'full' })
    assert.ok(full)
    assert.equal(full.interactions[0]?.processMode, 'full')
    assert.equal(full.interactions[0]?.nodes.some(node => node.type === 'tool'), true)
    assert.equal(full.interactions[0]?.nodes.some(node => node.type === 'message' && node.role === 'commentary'), true)
  } finally {
    storage.close()
  }
})


test('Review full detail keeps complete Process Summary before bounding 600-node body', () => {
  const base = {
    at: '2026-09-20T01:00:00.000Z',
    sourceId: 'codex',
    payload: {},
    evidence: [],
    observationIds: [],
    capturedAt: '2026-09-20T01:00:00.000Z',
  }
  const nodes = [
    { ...base, type: 'message' as const, id: 'user-large', role: 'user' as const, text: 'large' },
    ...Array.from({ length: 605 }, (_, index) => ({
      ...base,
      type: 'message' as const,
      id: `commentary-large-${index}`,
      role: 'commentary' as const,
      text: `step ${index}`,
    })),
    { ...base, type: 'message' as const, id: 'assistant-large', role: 'assistant' as const, text: 'done' },
  ]
  const interaction = {
    id: 'large-round',
    ordinal: 1,
    trigger: 'user' as const,
    startedAt: base.at,
    endedAt: base.at,
    nodes,
  }

  const summary = reviewProjectionInternals.processSummary(interaction)
  const bounded = reviewProjectionInternals.boundInteractionNodes({ ...interaction, processSummary: summary, processMode: 'full' })
  assert.equal(summary.messageCount, 605)
  assert.equal(summary.itemCount, 605)
  assert.equal(summary.totalFactCount, 607)
  assert.equal(summary.availability, 'partial')
  assert.equal(summary.omittedFactCount, 7)
  assert.equal(bounded.nodes.length, 600)
  assert.equal(bounded.nodesTruncated, true)
  assert.equal(bounded.processSummary?.messageCount, 605)
  assert.equal(bounded.processSummary?.availability, 'partial')
})


test('Review full ordinal reuses the header index and only materializes the target round', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'review-exact-round-host' })
    const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'codex' })
    const common = { sourceId: 'codex', host, installation, evidenceCandidates: [] }
    let sessionId = ''

    for (let round = 1; round <= 3; round += 1) {
      const minute = String(round).padStart(2, '0')
      const user = await observations.commit({
        ...common,
        candidate: {
          kind: 'message.user',
          nativeEventId: `exact-user-${round}`,
          occurredAt: `2026-09-20T02:${minute}:00.000Z`,
          capturedAt: `2026-09-20T02:${minute}:00.000Z`,
          payload: { text: `round ${round}` },
          identityHints: { nativeSessionId: 'review-exact-round-session' },
          dedupHints: { nativeEventId: `exact-user-${round}` },
        },
      })
      sessionId = user.observation.logicalSessionId
      await observations.commit({
        ...common,
        candidate: {
          kind: 'message.commentary',
          nativeEventId: `exact-commentary-${round}`,
          occurredAt: `2026-09-20T02:${minute}:01.000Z`,
          capturedAt: `2026-09-20T02:${minute}:01.000Z`,
          payload: { text: `work ${round}` },
          identityHints: { nativeSessionId: 'review-exact-round-session' },
          dedupHints: { nativeEventId: `exact-commentary-${round}` },
        },
      })
      await observations.commit({
        ...common,
        candidate: {
          kind: 'message.assistant',
          nativeEventId: `exact-assistant-${round}`,
          occurredAt: `2026-09-20T02:${minute}:02.000Z`,
          capturedAt: `2026-09-20T02:${minute}:02.000Z`,
          payload: { text: `done ${round}` },
          identityHints: { nativeSessionId: 'review-exact-round-session' },
          dedupHints: { nativeEventId: `exact-assistant-${round}` },
        },
      })
    }

    const projection = new ReviewProjection(storage)
    const summary = await projection.get(sessionId, { direction: 'backward', limit: 3, process: 'summary' })
    assert.ok(summary)
    const summaryRound = summary.interactions.find(item => item.ordinal === 3)
    assert.ok(summaryRound?.processSummary)

    const repository = storage.repositories.observations
    const originalQuery = repository.query.bind(repository)
    let unboundedSessionReads = 0
    let boundedTargetReads = 0
    repository.query = async query => {
      if (query.logicalSessionId === sessionId) {
        if (!query.after && !query.kind) unboundedSessionReads += 1
        else boundedTargetReads += 1
      }
      return originalQuery(query)
    }

    const full = await projection.get(sessionId, { ordinal: 3, process: 'full' })
    assert.ok(full)
    const fullRound = full.interactions[0]
    assert.equal(fullRound?.ordinal, 3)
    assert.equal(fullRound?.nodes.some(node => node.type === 'message' && node.role === 'commentary' && node.text === 'work 3'), true)
    assert.equal(unboundedSessionReads, 0)
    assert.ok(boundedTargetReads <= 1)
    assert.equal(fullRound?.processSummary?.revision, summaryRound?.processSummary?.revision)
  } finally {
    storage.close()
  }
})
