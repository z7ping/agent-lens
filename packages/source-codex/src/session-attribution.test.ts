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
    parserVersion: '13',
  }
}

test('parent_thread_id is a subagent signal even when legacy metadata omits thread_source details', async () => {
  const output = await codexSourceDefinition.normalize(record({
    id: 'child-thread',
    parent_thread_id: 'root-thread',
    source: 'cli',
  }, 'child-thread'), ctx)

  assert.equal((output.observations[0]?.payload as any).sessionActivity, 'subagent')
  assert.equal(output.sessionRelationshipHints?.find(item => item.fromNativeSessionId === 'root-thread')?.type, 'subagent')
})

test('user thread without parent remains a real user task', async () => {
  const output = await codexSourceDefinition.normalize(record({
    session_id: 'root-thread',
    source: 'vscode',
    thread_source: 'user',
  }, 'root-thread'), ctx)

  assert.equal((output.observations[0]?.payload as any).sessionActivity, 'user-task')
  assert.equal(output.sessionRelationshipHints?.length ?? 0, 0)
})
