import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceRecord } from '@agent-lens/core'
import { normalizeClaudeRecord } from './index'

function historyRecord(entry: Record<string, unknown>, nativeType: string): SourceRecord {
  return {
    id: `claude-${nativeType}`,
    sourceId: 'claude-code',
    installationId: 'installation-claude',
    sourceSessionNativeId: 'claude-session-1',
    nativeType: `history/${nativeType}`,
    sourceSequence: nativeType === 'custom-title' ? 2 : 3,
    capturedAt: '2026-08-31T00:30:00.000Z',
    locator: { kind: 'file', path: '/tmp/.claude/projects/demo/claude-session-1.jsonl', offset: 128 },
    fingerprint: `${nativeType}-fingerprint`,
    parserVersion: '2',
    payload: {
      entry: {
        sessionId: 'claude-session-1',
        ...entry,
      },
      session: {
        nativeSessionId: 'claude-session-1',
        cwd: '/workspace/agent-lens',
      },
    },
  }
}

test('Claude Code custom-title is treated as the native session title', async () => {
  const normalized = await normalizeClaudeRecord(historyRecord({
    type: 'custom-title',
    customTitle: 'Claude Code 原生会话标题',
  }, 'custom-title'), {} as never)

  assert.equal(normalized.observations.length, 1)
  assert.equal(normalized.observations[0]?.kind, 'session.lifecycle')
  assert.equal(normalized.observations[0]?.identityHints.sessionTitle, 'Claude Code 原生会话标题')
})

test('Claude Code summary remains context summary and never becomes sessionTitle', async () => {
  const normalized = await normalizeClaudeRecord(historyRecord({
    type: 'summary',
    summary: '这是压缩后的上下文摘要，不是会话标题',
  }, 'summary'), {} as never)

  assert.equal(normalized.observations.length, 1)
  assert.equal(normalized.observations[0]?.kind, 'context.summary')
  assert.equal(normalized.observations[0]?.identityHints.sessionTitle, undefined)
})
