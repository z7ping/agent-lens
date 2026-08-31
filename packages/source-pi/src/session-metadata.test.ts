import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceRecord } from '@agent-lens/core'
import { DefaultIdentityService, DefaultObservationService } from '@agent-lens/core-services'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { normalizePiRecord } from './index'

function sessionInfoRecord(): SourceRecord {
  return {
    id: 'pi-session-info-record',
    sourceId: 'pi',
    installationId: 'installation-pi',
    sourceSessionNativeId: 'pi-session-1',
    nativeType: 'history/session_info',
    nativeId: 'pi-session-info-1',
    sourceSequence: 2000,
    occurredAt: '2026-08-20T11:00:05.000Z',
    capturedAt: '2026-08-31T00:30:00.000Z',
    locator: { kind: 'file', path: '/tmp/.pi/agent/sessions/demo/session.jsonl', offset: 128 },
    fingerprint: 'pi-session-info-fingerprint',
    parserVersion: '1',
    payload: {
      entry: {
        type: 'session_info',
        id: 'pi-session-info-1',
        timestamp: '2026-08-20T11:00:05.000Z',
        name: 'Pi 原生会话名称',
      },
      session: {
        nativeSessionId: 'pi-session-1',
        cwd: '/workspace/agent-lens',
      },
    },
  }
}

test('Pi session_info.name becomes native sessionTitle metadata', async () => {
  const normalized = await normalizePiRecord(sessionInfoRecord(), {} as never)
  assert.equal(normalized.observations.length, 1)
  assert.equal(normalized.observations[0]?.kind, 'session.lifecycle')
  assert.equal(normalized.observations[0]?.identityHints.sessionTitle, 'Pi 原生会话名称')
})

test('Pi native title is persisted on LogicalSession without replacing source time with capturedAt', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'pi-session-metadata-host' })
    const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'pi' })
    const record = sessionInfoRecord()
    const normalized = await normalizePiRecord(record, {} as never)
    const candidate = normalized.observations[0]!
    const result = await observations.commit({
      sourceId: 'pi',
      host,
      installation,
      candidate,
      evidenceCandidates: normalized.evidenceCandidates,
    })

    const logical = await storage.repositories.sessions.getLogicalSession(result.observation.logicalSessionId)
    assert.equal(logical?.title, 'Pi 原生会话名称')
    assert.equal(result.observation.occurredAt, '2026-08-20T11:00:05.000Z')
    assert.equal(result.observation.capturedAt, '2026-08-31T00:30:00.000Z')
  } finally {
    storage.close()
  }
})
