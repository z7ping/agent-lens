import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceRecord } from '@agent-lens/core'
import { normalizeCurrentCodexRecord } from './current-protocol'
import { nativeIdForEntry, nativeTypeForEntry } from './format'

const ctx = {
  host: { id: 'host', name: 'host', platform: 'linux', arch: 'x64', createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z' },
  installation: { id: 'install', hostId: 'host', productId: 'codex', firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z' },
} as any

function record(): SourceRecord {
  const entry = {
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: 'thread-root',
      turn_id: 'turn-1',
      item: {
        type: 'FunctionCallOutput',
        id: 'call-1',
        name: 'read_file',
        namespace: 'workspace',
        output: 'file contents',
      },
    },
  }
  const nativeId = nativeIdForEntry(entry)
  return {
    id: 'function-output-record',
    sourceId: 'codex',
    installationId: 'install',
    sourceSessionNativeId: 'thread-root',
    nativeType: nativeTypeForEntry(entry),
    ...(nativeId ? { nativeId } : {}),
    sourceSequence: 10,
    occurredAt: '2026-09-05T08:10:00.000Z',
    capturedAt: '2026-09-05T08:10:01.000Z',
    locator: { kind: 'file', path: '/safe/paginated.jsonl', offset: 10 },
    payload: { entry, session: { nativeSessionId: 'thread-root', cwd: '/safe/project' } },
    parserVersion: '14',
  }
}

test('Paginated FunctionCallOutput becomes canonical tool result', async () => {
  const output = await normalizeCurrentCodexRecord(record(), ctx)
  const fact = output.observations[0]!
  assert.equal(fact.kind, 'tool.result')
  assert.equal(fact.nativeEventId, 'call-1')
  assert.equal((fact.payload as any).callId, 'call-1')
  assert.equal((fact.payload as any).nativeToolName, 'read_file')
  assert.equal((fact.payload as any).namespace, 'workspace')
  assert.equal((fact.payload as any).output, 'file contents')
  assert.equal((fact.payload as any).sourceSignal, 'event_msg.item_completed.FunctionCallOutput')
  assert.equal((fact.payload as any).turnId, 'turn-1')
})
