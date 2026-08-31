import assert from 'node:assert/strict'
import test from 'node:test'
import { DefaultIdentityService, DefaultObservationService } from '@agent-lens/core-services'
import { SqliteStorageService } from './storage'

test('session summary projection sorts and paginates by session start time', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()

  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'dogfood-host', platform: 'win32', arch: 'x64' })
    const installation = await identity.resolveInstallation({
      hostId: host.id,
      productId: 'codex',
      configRoot: 'C:\\Users\\test\\.codex',
    })

    const commitMessage = async (nativeSessionId: string, occurredAt: string, text: string) => observations.commit({
      sourceId: 'codex',
      host,
      installation,
      candidate: {
        kind: 'message.user',
        nativeEventId: `${nativeSessionId}:${occurredAt}`,
        occurredAt,
        capturedAt: occurredAt,
        payload: { text },
        identityHints: { nativeSessionId },
        dedupHints: { nativeEventId: `${nativeSessionId}:${occurredAt}` },
      },
      evidenceCandidates: [],
    })

    const older = await commitMessage('session-older', '2026-08-25T10:00:00.000Z', '较早会话')
    const newer = await commitMessage('session-newer', '2026-08-25T10:05:00.000Z', '较新会话')

    const fallback = await storage.sessionSummaries.query({ limit: 10 })
    assert.equal(fallback.items.length, 2)
    assert.equal(fallback.items[0]?.logicalSessionId, newer.observation.logicalSessionId)
    assert.equal(fallback.items[0]?.startedAt, '2026-08-25T10:05:00.000Z')

    const exactFallback = await storage.sessionSummaries.query({
      logicalSessionId: older.observation.logicalSessionId,
      limit: 1,
    })
    assert.deepEqual(exactFallback.items.map(item => item.logicalSessionId), [older.observation.logicalSessionId])

    await storage.sessionSummaryProjection.rebuild()
    assert.equal(Number((storage.db.prepare('SELECT COUNT(*) AS count FROM session_summary_projection').get() as { count: number }).count), 2)

    const projected = await storage.sessionSummaries.query({ limit: 10 })
    assert.deepEqual(
      projected.items.map(item => [item.logicalSessionId, item.startedAt, item.endedAt, item.observationCount]),
      fallback.items.map(item => [item.logicalSessionId, item.startedAt, item.endedAt, item.observationCount]),
    )

    const exactProjected = await storage.sessionSummaries.query({
      logicalSessionId: newer.observation.logicalSessionId,
      limit: 1,
    })
    assert.deepEqual(exactProjected.items.map(item => item.logicalSessionId), [newer.observation.logicalSessionId])

    const firstPage = await storage.sessionSummaries.query({ limit: 1 })
    assert.equal(firstPage.hasMore, true)
    assert.equal(firstPage.items.length, 1)
    const first = firstPage.items[0]!
    const secondPage = await storage.sessionSummaries.query({
      limit: 1,
      after: { startedAt: first.startedAt, logicalSessionId: first.logicalSessionId },
    })
    assert.deepEqual(secondPage.items.map(item => item.logicalSessionId), [older.observation.logicalSessionId])
    assert.equal(secondPage.hasMore, false)

    const searched = await storage.sessionSummaries.query({ limit: 10, search: '较早会话' })
    assert.deepEqual(searched.items.map(item => item.logicalSessionId), [older.observation.logicalSessionId])

    const pending = await commitMessage('session-pending', '2026-08-25T10:07:00.000Z', '尚在刷新窗口中的新会话')
    const exactPending = await storage.sessionSummaries.query({
      logicalSessionId: pending.observation.logicalSessionId,
      limit: 1,
    })
    assert.deepEqual(exactPending.items.map(item => item.logicalSessionId), [pending.observation.logicalSessionId])
    assert.equal(exactPending.items[0]?.observationCount, 1)

    await commitMessage('session-older', '2026-08-25T10:10:00.000Z', '较早会话后来又有新消息')
    // 前面的 exactPending 故意验证“全局 Projection 已存在但单会话仍在 debounce 窗口”时
    // 能回退 Canonical Query。验证全局排序前要把 pending 与 older 都 materialize，
    // 避免用一个刻意不完整的投影视图判断 startedAt 排序语义。
    await storage.sessionSummaryProjection.rebuild({ logicalSessionId: pending.observation.logicalSessionId })
    await storage.sessionSummaryProjection.rebuild({ logicalSessionId: older.observation.logicalSessionId })

    const refreshed = await storage.sessionSummaries.query({ limit: 10 })
    assert.equal(refreshed.items[0]?.logicalSessionId, pending.observation.logicalSessionId)
    assert.equal(refreshed.items[1]?.logicalSessionId, newer.observation.logicalSessionId)
    assert.equal(refreshed.items[2]?.logicalSessionId, older.observation.logicalSessionId)
    assert.equal(refreshed.items[2]?.startedAt, '2026-08-25T10:00:00.000Z')
    assert.equal(refreshed.items[2]?.endedAt, '2026-08-25T10:10:00.000Z')
    assert.equal(refreshed.items[2]?.observationCount, 2)
  } finally {
    storage.close()
  }
})

test('capturedAt cannot move a historical session when real event time exists', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()

  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'historical-import-host', platform: 'win32', arch: 'x64' })
    const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'codex' })

    const real = await observations.commit({
      sourceId: 'codex', host, installation,
      candidate: {
        kind: 'message.user',
        nativeEventId: 'history-real',
        occurredAt: '2026-08-01T09:00:00.000Z',
        capturedAt: '2026-08-31T09:00:00.000Z',
        payload: { text: '旧会话真实消息' },
        identityHints: { nativeSessionId: 'history-session' },
        dedupHints: { nativeEventId: 'history-real' },
      },
      evidenceCandidates: [],
    })
    await observations.commit({
      sourceId: 'codex', host, installation,
      candidate: {
        kind: 'session.lifecycle',
        nativeEventId: 'history-import-metadata',
        capturedAt: '2026-08-31T09:05:00.000Z',
        payload: { event: 'session.discovered' },
        identityHints: { nativeSessionId: 'history-session' },
        dedupHints: { nativeEventId: 'history-import-metadata' },
      },
      evidenceCandidates: [],
    })

    const fallback = await storage.sessionSummaries.query({ logicalSessionId: real.observation.logicalSessionId, limit: 1 })
    assert.equal(fallback.items[0]?.startedAt, '2026-08-01T09:00:00.000Z')
    assert.equal(fallback.items[0]?.endedAt, '2026-08-01T09:00:00.000Z')

    await storage.sessionSummaryProjection.rebuild()
    const projected = await storage.sessionSummaries.query({ logicalSessionId: real.observation.logicalSessionId, limit: 1 })
    assert.equal(projected.items[0]?.startedAt, '2026-08-01T09:00:00.000Z')
    assert.equal(projected.items[0]?.endedAt, '2026-08-01T09:00:00.000Z')
  } finally {
    storage.close()
  }
})

test('capturedAt remains a whole-session fallback when no event has occurredAt', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()

  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'captured-fallback-host' })
    const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'unknown-agent' })
    let logicalSessionId = ''

    for (const [index, capturedAt] of ['2026-08-10T10:00:00.000Z', '2026-08-10T10:03:00.000Z'].entries()) {
      const nativeEventId = `captured-only-${index}`
      const result = await observations.commit({
        sourceId: 'unknown-agent', host, installation,
        candidate: {
          kind: 'unknown', nativeEventId, capturedAt,
          payload: { index },
          identityHints: { nativeSessionId: 'captured-only-session' },
          dedupHints: { nativeEventId },
        },
        evidenceCandidates: [],
      })
      logicalSessionId ||= result.observation.logicalSessionId
    }

    await storage.sessionSummaryProjection.rebuild()
    const summary = await storage.sessionSummaries.query({ logicalSessionId, limit: 1 })
    assert.equal(summary.items[0]?.startedAt, '2026-08-10T10:00:00.000Z')
    assert.equal(summary.items[0]?.endedAt, '2026-08-10T10:03:00.000Z')
  } finally {
    storage.close()
  }
})
