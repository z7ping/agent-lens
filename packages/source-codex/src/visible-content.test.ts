import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceRecord } from '@agent-lens/core'
import { normalizeCodexRecord } from './normalize'

const ctx = {
  host: {
    id: 'host', name: 'host', platform: 'win32', arch: 'x64',
    createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z',
  },
  installation: {
    id: 'install', hostId: 'host', productId: 'codex',
    firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z',
  },
} as any

function messageRecord(role: 'assistant' | 'user', text: string, phase?: string): SourceRecord {
  return {
    id: `record-${role}-${phase ?? 'none'}`,
    sourceId: 'codex',
    installationId: 'install',
    sourceSessionNativeId: 'thread-visible-content',
    nativeType: 'response_item/message',
    nativeId: `message-${role}`,
    sourceSequence: 1,
    occurredAt: '2026-09-01T00:00:00.000Z',
    capturedAt: '2026-09-03T00:00:00.000Z',
    locator: { kind: 'file', path: 'C:\\Users\\test\\.codex\\sessions\\rollout.jsonl', offset: 1 },
    parserVersion: '5',
    payload: {
      entry: {
        type: 'response_item',
        payload: {
          type: 'message',
          role,
          ...(phase ? { phase } : {}),
          content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
        },
      },
      session: { nativeSessionId: 'thread-visible-content', cwd: 'F:\\proj' },
    },
  }
}

function userMessageRecord(text: string): SourceRecord {
  return {
    id: 'record-user-authoritative',
    sourceId: 'codex',
    installationId: 'install',
    sourceSessionNativeId: 'thread-visible-content',
    nativeType: 'event_msg/user_message',
    nativeId: 'user-message-authoritative',
    sourceSequence: 2,
    occurredAt: '2026-09-01T00:00:00.000Z',
    capturedAt: '2026-09-03T00:00:00.000Z',
    locator: { kind: 'file', path: 'C:\\Users\\test\\.codex\\sessions\\rollout.jsonl', offset: 2 },
    parserVersion: '5',
    payload: {
      entry: {
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: text,
          kind: 'plain',
        },
      },
      session: { nativeSessionId: 'thread-visible-content', cwd: 'F:\\proj' },
    },
  }
}

const machineBlock = '<oai-mem-citation><citation_entries>mem-1</citation_entries><rollout_ids>rollout-1</rollout_ids></oai-mem-citation>'

test('Codex final_answer strips trailing client memory metadata while preserving visible text', async () => {
  const output = await normalizeCodexRecord(messageRecord('assistant', `最终可见回答\n${machineBlock}`, 'final_answer'), ctx)
  const fact = output.observations[0]!
  assert.equal(fact.kind, 'message.assistant')
  assert.equal((fact.payload as any).text, '最终可见回答')
  assert.deepEqual((fact.payload as any).sourceMetadata, [{ kind: 'memory.citation' }])
  assert.equal(JSON.stringify((fact.payload as any).text).includes('rollout_ids'), false)
})

test('用户主动引用相同标签时原样保留', async () => {
  const output = await normalizeCodexRecord(userMessageRecord(`请解释这个标签：${machineBlock}`), ctx)
  assert.equal(output.observations[0]?.kind, 'message.user')
  assert.equal((output.observations[0]?.payload as any).text, `请解释这个标签：${machineBlock}`)
  assert.equal((output.observations[0]?.payload as any).provenance.actualAuthor, 'human-user')
})

test('response_item role=user remains transport context instead of a user request', async () => {
  const output = await normalizeCodexRecord(messageRecord('user', 'transport echo'), ctx)
  assert.equal(output.observations[0]?.kind, 'context.injected')
  assert.equal((output.observations[0]?.payload as any).provenance.transportEcho, true)
})

test('代码块中的相同机器标签不会被误删', async () => {
  const text = `示例：\n\`\`\`xml\n${machineBlock}\n\`\`\``
  const output = await normalizeCodexRecord(messageRecord('assistant', text, 'final_answer'), ctx)
  assert.equal((output.observations[0]?.payload as any).text, text)
})

test('非 final_answer assistant 文本不做客户端机器块裁剪', async () => {
  const text = `过程说明\n${machineBlock}`
  const output = await normalizeCodexRecord(messageRecord('assistant', text, 'commentary'), ctx)
  assert.equal(output.observations[0]?.kind, 'message.commentary')
  assert.equal((output.observations[0]?.payload as any).text, text)
})
