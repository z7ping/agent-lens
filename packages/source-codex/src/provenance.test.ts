import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentInstallation, Host, SourceRecord } from '@agent-lens/core'
import { codexSourceDefinition } from './index'

const host: Host = {
  id: 'host-provenance',
  name: 'test-host',
  platform: process.platform,
  arch: process.arch,
  createdAt: '2026-09-04T00:00:00.000Z',
  lastSeenAt: '2026-09-04T00:00:00.000Z',
}

const installation: AgentInstallation = {
  id: 'codex-provenance-install',
  hostId: host.id,
  productId: 'codex',
  configRoot: '/tmp/codex',
  dataRoot: '/tmp/codex/sessions',
  firstSeenAt: '2026-09-04T00:00:00.000Z',
  lastSeenAt: '2026-09-04T00:00:00.000Z',
}

function record(entry: Record<string, unknown>, id: string, sessionId = 'session-main'): SourceRecord {
  return {
    id,
    sourceId: 'codex',
    installationId: installation.id,
    sourceSessionNativeId: sessionId,
    nativeType: `${String(entry.type ?? 'unknown')}/${String((entry.payload as any)?.type ?? '')}`,
    sourceSequence: 1,
    capturedAt: '2026-09-04T00:00:01.000Z',
    locator: { kind: 'file', path: '/tmp/codex/sessions/rollout.jsonl', offset: 10 },
    fingerprint: `${id}-fingerprint`,
    payload: { entry, session: { nativeSessionId: sessionId, cwd: '/workspace' } },
    parserVersion: '11',
  }
}

async function normalize(value: SourceRecord) {
  return codexSourceDefinition.normalize(value, { host, installation })
}

test('user-authored AGENTS/XML stays a real user request because event_msg is authoritative', async () => {
  const output = await normalize(record({
    type: 'event_msg',
    payload: {
      type: 'user_message',
      message: '<recommended_plugins>我主动发的文本</recommended_plugins>\n# AGENTS.md',
      kind: 'plain',
    },
  }, 'user-authored-system-looking-text'))

  assert.equal(output.observations[0]?.kind, 'message.user')
  assert.equal((output.observations[0]?.payload as any).provenance.actualAuthor, 'human-user')
})

test('response_item role=user is preserved as transport echo instead of a user bubble', async () => {
  const output = await normalize(record({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '真实正文的 transport echo' }],
    },
  }, 'response-echo'))

  assert.equal(output.observations[0]?.kind, 'context.injected')
  assert.equal((output.observations[0]?.payload as any).provenance.transportEcho, true)
  assert.equal((output.observations[0]?.payload as any).text, '真实正文的 transport echo')
})

test('user message keeps body and separates attachment metadata', async () => {
  const output = await normalize(record({
    type: 'event_msg',
    payload: {
      type: 'user_message',
      message: '分析附件',
      images: ['https://example.invalid/a.png'],
      local_images: ['/tmp/a.png'],
      text_elements: [{ start: 0, end: 4 }],
    },
  }, 'attachment-user-message'))

  const payload = output.observations[0]?.payload as any
  assert.equal(payload.text, '分析附件')
  assert.equal(payload.attachments.length, 3)
  assert.deepEqual(payload.attachments.map((item: any) => item.kind), ['images', 'local_images', 'text_elements'])
})

test('guardian subagent session is linked as internal-review', async () => {
  const output = await normalize(record({
    type: 'session_meta',
    payload: {
      id: 'guardian-child',
      session_id: 'guardian-child',
      parent_thread_id: 'parent-task',
      thread_source: 'subagent',
      source: { subagent: { other: 'guardian' } },
      agent_role: 'reviewer',
    },
  }, 'guardian-meta', 'guardian-child'))

  assert.equal((output.observations[0]?.payload as any).sessionActivity, 'internal-review')
  assert.equal(output.observations[0]?.identityHints.nativeParentSessionId, 'parent-task')
  assert.equal(output.sessionRelationshipHints?.[0]?.type, 'internal-review')
})

test('normal subagent remains subagent and is not treated as guardian review', async () => {
  const output = await normalize(record({
    type: 'session_meta',
    payload: {
      id: 'worker-child',
      session_id: 'worker-child',
      parent_thread_id: 'parent-task',
      thread_source: 'subagent',
      source: { subagent: { other: 'worker' } },
      agent_role: 'worker',
    },
  }, 'subagent-meta', 'worker-child'))

  assert.equal((output.observations[0]?.payload as any).sessionActivity, 'subagent')
  assert.equal(output.sessionRelationshipHints?.[0]?.type, 'subagent')
})
