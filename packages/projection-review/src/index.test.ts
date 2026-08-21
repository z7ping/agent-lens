import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DefaultIdentityService,
  DefaultObservationService,
} from '@agent-lens/core-services'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { ReviewProjection } from './index'

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
      kind: 'message.user' | 'message.assistant' | 'tool.call' | 'tool.result',
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
    await add('message.assistant', 'assistant-1', '2026-08-21T01:00:01.000Z', { text: '开始检查' })
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
    assert.equal(summary.toolCount, 1)
    assert.equal(summary.errorCount, 1)
    assert.equal(summary.hasErrors, true)

    const detail = await projection.get(summary.id)
    assert.ok(detail)
    assert.equal(detail.interactions.length, 1)
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
