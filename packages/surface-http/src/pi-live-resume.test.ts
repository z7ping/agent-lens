import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DefaultIdentityService, DefaultObservationService } from '@agent-lens/core-services'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { resolvePiLiveResumeInput } from './pi-live-resume'

test('从规范 Pi 会话证据解析原生 JSONL、工作目录和继续动作', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-resume-'))
  const workspacePath = join(root, 'workspace')
  const sessionPath = join(root, 'session.jsonl')
  await writeFile(sessionPath, `${JSON.stringify({ type: 'session', id: 'pi-native-1', cwd: workspacePath })}\n`, 'utf8')

  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'pi-resume-host' })
    const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'pi' })
    const sourceRecordId = 'pi-resume-record-1'
    await storage.repositories.sourceRecords.put({
      id: sourceRecordId,
      sourceId: 'pi',
      installationId: installation.id,
      sourceSessionNativeId: 'pi-native-1',
      nativeType: 'history/session',
      nativeId: 'session:pi-native-1',
      capturedAt: '2026-09-04T10:00:00.000Z',
      locator: { kind: 'file', path: sessionPath, offset: 0 },
      payload: { session: { nativeSessionId: 'pi-native-1', cwd: workspacePath } },
      parserVersion: '4',
    })
    const committed = await observations.commit({
      sourceId: 'pi',
      host,
      installation,
      candidate: {
        kind: 'session.lifecycle',
        nativeEventId: 'session:pi-native-1',
        capturedAt: '2026-09-04T10:00:00.000Z',
        payload: { event: 'session_start' },
        identityHints: { nativeSessionId: 'pi-native-1', workspacePath },
      },
      evidenceCandidates: [{
        captureMethod: 'native-log',
        derivation: 'reported',
        sourceRecordId,
        sourceLocator: { kind: 'file', path: sessionPath, offset: 0 },
        parserVersion: '4',
        capturedAt: '2026-09-04T10:00:00.000Z',
        confidenceHint: 'exact',
      }],
    })

    assert.equal(
      (await storage.repositories.sessions.getSourceSession(committed.observation.sourceSessionId))?.sourceId,
      'pi',
    )
    assert.equal(
      (await storage.repositories.observations.query({
        logicalSessionId: committed.observation.logicalSessionId,
        limit: 5_000,
      })).length,
      1,
    )

    assert.deepEqual(
      await resolvePiLiveResumeInput(storage, committed.observation.logicalSessionId),
      { cwd: workspacePath, sessionPath, historyAction: 'continue' },
    )
    assert.deepEqual(
      await resolvePiLiveResumeInput(storage, committed.observation.logicalSessionId, 'fork'),
      { cwd: workspacePath, sessionPath, historyAction: 'fork' },
    )

    await writeFile(sessionPath, `${JSON.stringify({ type: 'session', id: 'different-pi-session', cwd: workspacePath })}\n`, 'utf8')
    await assert.rejects(
      () => resolvePiLiveResumeInput(storage, committed.observation.logicalSessionId),
      /原生 JSONL 与该 Pi 历史会话不匹配/,
    )
  } finally {
    storage.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('非 Pi 会话不会进入恢复链路', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'codex-resume-host' })
    const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'codex' })
    const committed = await observations.commit({
      sourceId: 'codex',
      host,
      installation,
      candidate: {
        kind: 'message.user',
        capturedAt: '2026-09-04T10:00:00.000Z',
        payload: { text: 'hello' },
        identityHints: { nativeSessionId: 'codex-1', workspacePath: 'F:\\workspace' },
      },
      evidenceCandidates: [{ captureMethod: 'native-log', derivation: 'reported', capturedAt: '2026-09-04T10:00:00.000Z' }],
    })

    await assert.rejects(
      () => resolvePiLiveResumeInput(storage, committed.observation.logicalSessionId),
      /只有本机 Pi 历史会话可以继续/,
    )
  } finally {
    storage.close()
  }
})
