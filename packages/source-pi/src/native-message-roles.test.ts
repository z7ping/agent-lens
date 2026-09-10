import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceRecord } from '@agent-lens/core'
import { normalizePiRecord } from './index'

function sourceRecord(entry: Record<string, unknown>): SourceRecord {
  const id = typeof entry.id === 'string' ? entry.id : undefined
  return {
    id: `pi-record-${id ?? 'unknown'}`,
    sourceId: 'pi',
    installationId: 'installation-pi',
    sourceSessionNativeId: 'pi-session-roles',
    nativeType: `history/${String(entry.type ?? 'unknown')}`,
    ...(id ? { nativeId: id } : {}),
    sourceSequence: 1000,
    occurredAt: '2026-09-10T00:00:00.000Z',
    capturedAt: '2026-09-10T00:00:01.000Z',
    locator: { kind: 'file', path: '/tmp/pi/session.jsonl', offset: 1 },
    fingerprint: `fingerprint-${id ?? 'unknown'}`,
    parserVersion: '7',
    payload: {
      entry,
      session: {
        nativeSessionId: 'pi-session-roles',
        cwd: '/workspace/pi',
      },
    },
  }
}

test('Pi extension custom messages are application context, never human user messages', async () => {
  const normalized = await normalizePiRecord(sourceRecord({
    type: 'message',
    id: 'custom-message',
    parentId: 'user-message',
    timestamp: '2026-09-10T00:00:00.000Z',
    message: {
      role: 'custom',
      customType: 'handoff',
      content: [{ type: 'text', text: 'extension context' }],
      display: true,
      timestamp: 1789000000000,
    },
  }), {} as never)

  assert.equal(normalized.observations.length, 1)
  const observation = normalized.observations[0]!
  assert.equal(observation.kind, 'context.injected')
  const payload = observation.payload as {
    text?: string
    provenance?: { actualAuthor?: string; contentRole?: string; injectedKind?: string }
  }
  assert.equal(payload.text, 'extension context')
  assert.equal(payload.provenance?.actualAuthor, 'application')
  assert.equal(payload.provenance?.contentRole, 'application-context')
  assert.equal(payload.provenance?.injectedKind, 'handoff')
})

test('Pi persisted branch and compaction summary roles keep canonical context semantics', async () => {
  const branch = await normalizePiRecord(sourceRecord({
    type: 'message',
    id: 'branch-message',
    message: { role: 'branchSummary', summary: 'branch summary', fromId: 'entry-1', timestamp: 1789000000000 },
  }), {} as never)
  assert.equal(branch.observations[0]?.kind, 'context.summary')

  const compaction = await normalizePiRecord(sourceRecord({
    type: 'message',
    id: 'compaction-message',
    message: { role: 'compactionSummary', summary: 'compact', tokensBefore: 1200, timestamp: 1789000000000 },
  }), {} as never)
  assert.equal(compaction.observations[0]?.kind, 'context.compaction')
})

test('Pi user-triggered bash execution remains explicit activity without being misreported as an agent tool call', async () => {
  const normalized = await normalizePiRecord(sourceRecord({
    type: 'message',
    id: 'bash-message',
    message: {
      role: 'bashExecution',
      command: 'pwd',
      output: '/workspace/pi',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 1789000000000,
    },
  }), {} as never)

  assert.equal(normalized.observations.length, 1)
  const observation = normalized.observations[0]!
  assert.equal(observation.kind, 'unknown')
  assert.equal((observation.payload as { event?: string }).event, 'pi.bash_execution')
})
