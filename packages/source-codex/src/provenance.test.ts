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
      session_id: 'parent-task',
      parent_thread_id: 'parent-task',
      thread_source: 'subagent',
      source: { subagent: { other: 'guardian_review' } },
      agent_role: 'reviewer',
    },
  }, 'guardian-meta', 'guardian-child'))

  const payload = output.observations[0]?.payload as any
  assert.equal(payload.sessionActivity, 'internal-review')
  assert.equal(payload.rootSessionId, 'parent-task')
  assert.equal(payload.parentSessionId, 'parent-task')
  assert.equal(output.observations[0]?.identityHints.nativeParentSessionId, 'parent-task')
  assert.deepEqual(output.sessionRelationshipHints?.map(item => item.type).sort(), ['internal-review', 'task-root'])
})

test('normal subagent remains subagent and is not treated as guardian review', async () => {
  const output = await normalize(record({
    type: 'session_meta',
    payload: {
      id: 'worker-child',
      session_id: 'parent-task',
      parent_thread_id: 'parent-task',
      thread_source: 'subagent',
      source: { subagent: { other: 'worker' } },
      agent_role: 'worker',
    },
  }, 'subagent-meta', 'worker-child'))

  assert.equal((output.observations[0]?.payload as any).sessionActivity, 'subagent')
  assert.deepEqual(output.sessionRelationshipHints?.map(item => item.type).sort(), ['subagent', 'task-root'])
})

test('nested thread_spawn keeps direct parent and root task as separate relationships', async () => {
  const output = await normalize(record({
    type: 'session_meta',
    payload: {
      id: 'nested-worker',
      session_id: 'root-task',
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: 'direct-parent',
            depth: 2,
            agent_nickname: 'Meitner',
            agent_role: 'worker',
          },
        },
      },
    },
  }, 'nested-subagent-meta', 'nested-worker'))

  const payload = output.observations[0]?.payload as any
  assert.equal(payload.sessionActivity, 'subagent')
  assert.equal(payload.rootSessionId, 'root-task')
  assert.equal(payload.parentSessionId, 'direct-parent')
  assert.equal(payload.activitySourceLabel, 'Meitner')
  assert.deepEqual(output.sessionRelationshipHints?.map(item => [item.fromNativeSessionId, item.type, item.nativeRelation]), [
    ['root-task', 'task-root', 'session_id'],
    ['direct-parent', 'subagent', 'source.subagent.thread_spawn.parent_thread_id'],
  ])
})

test('native subagent source review is classified as internal review', async () => {
  const output = await normalize(record({
    type: 'session_meta',
    payload: {
      id: 'review-child',
      session_id: 'root-task',
      source: { subagent: 'review' },
    },
  }, 'native-review-meta', 'review-child'))

  assert.equal((output.observations[0]?.payload as any).sessionActivity, 'internal-review')
  assert.equal((output.observations[0]?.payload as any).activitySourceLabel, 'Guardian 审查')
  assert.equal(output.sessionRelationshipHints?.[0]?.type, 'task-root')
})

test('unlinked internal activity is preserved and marked orphan for system activity grouping', async () => {
  const output = await normalize(record({
    type: 'session_meta',
    payload: {
      id: 'orphan-worker',
      source: { subagent: { other: 'worker' } },
      agent_role: 'worker',
    },
  }, 'orphan-subagent-meta', 'orphan-worker'))

  const payload = output.observations[0]?.payload as any
  assert.equal(payload.sessionActivity, 'subagent')
  assert.equal(payload.orphanInternalActivity, true)
  assert.deepEqual(output.sessionRelationshipHints, [])
})
