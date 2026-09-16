import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceRecord } from '@agent-lens/core'
import { piSourceDefinition } from './index'

function record(locator: SourceRecord['locator']): SourceRecord {
  return {
    id: 'pi-raw-recovery',
    sourceId: 'pi',
    installationId: 'installation-pi',
    nativeType: 'history/message',
    capturedAt: '2026-09-16T00:00:00.000Z',
    locator,
    fingerprint: 'fingerprint',
    payload: { entry: { type: 'message' }, session: { nativeSessionId: 'session-1' } },
    parserVersion: '1',
  }
}

test('Pi JSONL history 可作为稳定可验证 reference 候选', () => {
  const capability = piSourceDefinition.rawRecovery?.describe(record({
    kind: 'file',
    path: '/tmp/pi/session.jsonl',
    offset: 42,
  }))
  assert.equal(capability?.authority, 'native-store')
  assert.equal(capability?.locatorStability, 'stable')
  assert.equal(capability?.verification, 'fingerprint')
  assert.equal(capability?.canReparse, true)
  assert.equal(capability?.persistencePreference, 'reference')
})

test('Pi 非稳定 locator 默认 preserve', () => {
  const capability = piSourceDefinition.rawRecovery?.describe(record({
    kind: 'file',
    path: '/tmp/pi/session.jsonl',
  }))
  assert.equal(capability?.canReread, false)
  assert.equal(capability?.persistencePreference, 'preserve')
})
