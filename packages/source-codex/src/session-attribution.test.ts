import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceRecord } from '@agent-lens/core'
import { codexSourceDefinition } from './index'

const ctx = {
  host: { id: 'host', name: 'host', platform: 'linux', arch: 'x64', createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z' },
  installation: { id: 'install', hostId: 'host', productId: 'codex', firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z' },
} as any

function record(payload: Record<string, unknown>, nativeSessionId: string): SourceRecord {
  return {
    id: `record-${nativeSessionId}`,
    sourceId: 'codex',
    installationId: 'install',
    sourceSessionNativeId: nativeSessionId,
    nativeType: 'session_meta',
    sourceSequence: 1,
    occurredAt: '2026-09-05T06:00:00.000Z',
    capturedAt: '2026-09-05T06:00:00.000Z',
    locator: { kind: 'file', path: '/safe/rollout.jsonl', offset: 0 },
    payload: {
      entry: { type: 'session_meta', payload },
      session: { nativeSessionId, cwd: '/safe/project' },
    },
    parserVersion: '15',
  }
}

test('parent_thread_id is a subagent signal even when legacy metadata omits thread_source details', async () => {
  const output = await codexSourceDefinition.normalize(record({
    id: 'child-thread',
    session_id: 'shared-session',
    parent_thread_id: 'root-thread',
    source: 'cli',
  }, 'child-thread'), ctx)

  assert.equal((output.observations[0]?.payload as any).sessionActivity, 'subagent')
  assert.equal((output.observations[0]?.payload as any).parentSessionId, 'root-thread')
  assert.equal(output.sessionRelationshipHints?.find(item => item.fromNativeSessionId === 'root-thread')?.type, 'subagent')
})

test('shared session_id does not turn a root user thread into system activity', async () => {
  const output = await codexSourceDefinition.normalize(record({
    id: 'root-thread',
    session_id: 'shared-session',
    source: 'vscode',
    thread_source: 'user',
  }, 'root-thread'), ctx)

  assert.equal((output.observations[0]?.payload as any).sessionActivity, 'user-task')
  assert.equal((output.observations[0]?.payload as any).parentSessionId, undefined)
  assert.equal((output.observations[0]?.payload as any).rootSessionId, undefined)
  assert.equal(output.sessionRelationshipHints?.length ?? 0, 0)
})

test('forked_from_id remains an explicit branch relationship independent of session_id', async () => {
  const output = await codexSourceDefinition.normalize(record({
    id: 'fork-thread',
    session_id: 'shared-session',
    forked_from_id: 'root-thread',
    source: 'vscode',
    thread_source: 'user',
  }, 'fork-thread'), ctx)

  assert.equal((output.observations[0]?.payload as any).sessionActivity, 'branch-task')
  assert.equal((output.observations[0]?.payload as any).parentSessionId, 'root-thread')
  assert.equal(output.sessionRelationshipHints?.find(item => item.fromNativeSessionId === 'root-thread')?.type, 'branch-task')
})

test('source.subAgent thread_spawn preserves exact subagent ownership', async () => {
  const output = await codexSourceDefinition.normalize(record({
    id: 'child-app-server',
    session_id: 'shared-session',
    source: {
      subAgent: {
        thread_spawn: {
          parent_thread_id: 'root-thread',
          agent_nickname: 'worker-a',
          depth: 1,
        },
      },
    },
    thread_source: 'subagent',
  }, 'child-app-server'), ctx)

  assert.equal((output.observations[0]?.payload as any).sessionActivity, 'subagent')
  assert.equal((output.observations[0]?.payload as any).activitySourceLabel, 'worker-a')
  assert.equal(output.sessionRelationshipHints?.[0]?.nativeRelation, 'source.subAgent.thread_spawn.parent_thread_id')
})

test('source.sub_agent legacy/raw shape is also recognized structurally', async () => {
  const output = await codexSourceDefinition.normalize(record({
    id: 'child-raw',
    session_id: 'shared-session',
    source: {
      sub_agent: {
        thread_spawn: {
          parent_thread_id: 'root-thread',
          agent_role: 'worker',
          depth: 1,
        },
      },
    },
  }, 'child-raw'), ctx)

  assert.equal((output.observations[0]?.payload as any).sessionActivity, 'subagent')
  assert.equal(output.sessionRelationshipHints?.[0]?.nativeRelation, 'source.sub_agent.thread_spawn.parent_thread_id')
})

test('memory consolidation remains system activity instead of being promoted to a user task', async () => {
  const output = await codexSourceDefinition.normalize(record({
    id: 'memory-thread',
    session_id: 'shared-session',
    source: 'app_server',
    thread_source: 'memory_consolidation',
  }, 'memory-thread'), ctx)

  assert.equal((output.observations[0]?.payload as any).sessionActivity, 'system-activity')
  assert.equal((output.observations[0]?.payload as any).activitySourceLabel, '记忆整理')
})

test('feature thread remains system activity when no human user ownership exists', async () => {
  const output = await codexSourceDefinition.normalize(record({
    id: 'feature-thread',
    session_id: 'shared-session',
    source: 'app_server',
    thread_source: 'feature:background-job',
  }, 'feature-thread'), ctx)

  assert.equal((output.observations[0]?.payload as any).sessionActivity, 'system-activity')
})
