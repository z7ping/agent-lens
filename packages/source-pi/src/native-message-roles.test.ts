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
    parserVersion: '8',
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
  assert.equal(observation.kind, 'session.lifecycle')
  const payload = observation.payload as { event?: string; nativeSemantic?: string }
  assert.equal(payload.event, 'pi.bash_execution')
  assert.equal(payload.nativeSemantic, 'user-shell-activity')
})

test('Pi historical user images enter canonical attachments without duplicating image bytes in nonTextContent', async () => {
  const normalized = await normalizePiRecord(sourceRecord({
    type: 'message',
    id: 'image-message',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: '看看这张图' },
        { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
        { type: 'custom-block', value: 'keep-me' },
      ],
    },
  }), {} as never)

  const observation = normalized.observations[0]!
  assert.equal(observation.kind, 'message.user')
  const payload = observation.payload as {
    text?: string
    attachments?: Array<{ type?: string; mimeType?: string; data?: string }>
    nonTextContent?: unknown[]
  }
  assert.equal(payload.text, '看看这张图')
  assert.deepEqual(payload.attachments, [{
    type: 'image',
    mimeType: 'image/png',
    data: 'aGVsbG8=',
  }])
  assert.deepEqual(payload.nonTextContent, [{ type: 'custom-block', value: 'keep-me' }])
})


test('Pi 已知顶层扩展/标签/Bash 事件都有稳定语义，未来类型仍保留 unknown', async () => {
  const known = [
    { type: 'custom', id: 'custom-1', customType: 'extension-state', data: { value: 1 } },
    { type: 'custom_message', id: 'custom-message-1', customType: 'notice', content: [{ type: 'text', text: 'hello' }] },
    { type: 'label', id: 'label-1', label: 'checkpoint' },
    { type: 'bash', id: 'bash-1', command: 'pwd' },
    { type: 'bash_result', id: 'bash-result-1', output: '/workspace/pi' },
  ] as const

  for (const entry of known) {
    const normalized = await normalizePiRecord(sourceRecord(entry as unknown as Record<string, unknown>), {} as never)
    assert.equal(normalized.observations.some(item => item.kind === 'unknown'), false, entry.type)
  }

  const future = await normalizePiRecord(sourceRecord({
    type: 'future_pi_event',
    id: 'future-1',
    payload: { future: true },
  }), {} as never)
  assert.equal(future.observations[0]?.kind, 'unknown')
})

test('Pi 未知 Assistant 内容块不会伪装成模型正文', async () => {
  const normalized = await normalizePiRecord(sourceRecord({
    type: 'message',
    id: 'assistant-future-block',
    message: {
      role: 'assistant',
      content: [{ type: 'futureBlock', value: { survives: true } }],
    },
  }), {} as never)

  assert.equal(normalized.observations.length, 1)
  assert.equal(normalized.observations[0]?.kind, 'unknown')
  const payload = normalized.observations[0]?.payload as { rawType?: string; rawPayload?: unknown }
  assert.equal(payload.rawType, 'message/assistant/content/futureBlock')
  assert.deepEqual(payload.rawPayload, { type: 'futureBlock', value: { survives: true } })
})


test('Pi official system role maps to system context instead of unknown', async () => {
  const normalized = await normalizePiRecord(sourceRecord({
    type: 'message',
    id: 'system-message',
    message: {
      role: 'system',
      content: 'system instructions',
      timestamp: 1789000000000,
    },
  }), {} as never)

  assert.equal(normalized.observations[0]?.kind, 'context.injected')
  const payload = normalized.observations[0]?.payload as {
    text?: string
    provenance?: { contentRole?: string; actualAuthor?: string; nativeRole?: string }
  }
  assert.equal(payload.text, 'system instructions')
  assert.equal(payload.provenance?.contentRole, 'system-context')
  assert.equal(payload.provenance?.actualAuthor, 'system')
  assert.equal(payload.provenance?.nativeRole, 'system')
})

test('Pi official StopReason values are all preserved as explicit lifecycle facts', async () => {
  for (const stopReason of ['pending', 'stop', 'length', 'toolUse', 'error', 'aborted', 'deferred']) {
    const normalized = await normalizePiRecord(sourceRecord({
      type: 'message',
      id: `assistant-stop-${stopReason}`,
      message: {
        role: 'assistant',
        provider: 'test',
        model: 'test-model',
        stopReason,
        content: [{ type: 'text', text: 'response' }],
      },
    }), {} as never)

    const lifecycle = normalized.observations.find(item =>
      item.kind === 'session.lifecycle'
      && (item.payload as { stopReason?: string }).stopReason === stopReason)
    assert.ok(lifecycle, stopReason)
  }
})
