import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DefaultIdentityService,
  DefaultObservationService,
} from '@agent-lens/core-services'
import { SqliteStorageService } from './storage'

const now = '2026-08-20T07:00:00.000Z'

test('same Codex tool call from hook + JSONL becomes one observation with two evidence records', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()

  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({
      name: 'test-host',
      platform: 'win32',
      arch: 'x64',
    })
    const installation = await identity.resolveInstallation({
      hostId: host.id,
      productId: 'codex',
      configRoot: 'C:\\Users\\test\\.codex',
      dataRoot: 'C:\\Users\\test\\.codex\\sessions',
    })

    await storage.repositories.sourceRecords.put({
      id: 'hook-record',
      sourceId: 'codex',
      installationId: installation.id,
      sourceSessionNativeId: 'session-1',
      nativeType: 'hook/tool-call',
      nativeId: 'call_c1',
      occurredAt: now,
      capturedAt: now,
      locator: { kind: 'runtime-hook', hookEventId: 'hook-event-1' },
      payload: { callId: 'call_c1' },
      parserVersion: '1',
    })
    await storage.repositories.sourceRecords.put({
      id: 'jsonl-record',
      sourceId: 'codex',
      installationId: installation.id,
      sourceSessionNativeId: 'session-1',
      nativeType: 'response_item/function_call',
      nativeId: 'call_c1',
      occurredAt: now,
      capturedAt: now,
      locator: { kind: 'file', path: 'rollout.jsonl', offset: 10 },
      payload: { callId: 'call_c1' },
      parserVersion: '1',
    })

    const candidate = {
      kind: 'tool.call' as const,
      nativeEventId: 'call_c1',
      nativeCallId: 'call_c1',
      occurredAt: now,
      capturedAt: now,
      payload: {
        callId: 'call_c1',
        nativeToolName: 'shell_command',
        input: { command: 'npm test' },
      },
      identityHints: {
        nativeSessionId: 'session-1',
        workspacePath: 'F:\\proj',
      },
      dedupHints: {
        nativeEventId: 'call_c1',
        nativeCallId: 'call_c1',
      },
    }

    const first = await observations.commit({
      sourceId: 'codex',
      host,
      installation,
      candidate,
      evidenceCandidates: [{
        captureMethod: 'runtime-hook',
        derivation: 'observed',
        sourceRecordId: 'hook-record',
        sourceLocator: { kind: 'runtime-hook', hookEventId: 'hook-event-1' },
        parserVersion: '1',
        nativeStableId: 'call_c1',
        eventTime: now,
        capturedAt: now,
      }],
    })
    const second = await observations.commit({
      sourceId: 'codex',
      host,
      installation,
      candidate,
      evidenceCandidates: [{
        captureMethod: 'native-log',
        derivation: 'reported',
        sourceRecordId: 'jsonl-record',
        sourceLocator: { kind: 'file', path: 'rollout.jsonl', offset: 10 },
        parserVersion: '1',
        nativeStableId: 'call_c1',
        eventTime: now,
        capturedAt: now,
      }],
    })

    assert.equal(first.status, 'created')
    assert.equal(second.status, 'merged')
    assert.equal(first.observation.id, second.observation.id)
    assert.equal(second.observation.evidenceRefs.length, 2)

    const saved = await storage.repositories.observations.get(first.observation.id)
    assert.equal(saved?.evidenceRefs.length, 2)
    assert.equal((await storage.repositories.evidence.listForObservation(first.observation.id)).length, 2)
  } finally {
    storage.close()
  }
})
