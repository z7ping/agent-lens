import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import type {
  SourceExecutionContext,
  SourceHistoryExecutionContext,
  SourceRecord,
} from '@agent-lens/core'
import {
  claudeInternals,
  claudeManifest,
  declareClaudeCapabilities,
  discoverClaudeAssets,
  ingestClaudeHistory,
  normalizeClaudeRecord,
} from './index'

function record(entry: Record<string, unknown>, nativeId?: string): SourceRecord {
  return {
    id: 'claude-record-contract',
    sourceId: 'claude-code',
    installationId: 'installation-claude',
    sourceSessionNativeId: 'session-claude',
    nativeType: `history/${String(entry.type ?? 'unknown')}`,
    ...(nativeId ? { nativeId } : {}),
    sourceSequence: 100,
    capturedAt: '2026-09-11T00:00:00.000Z',
    locator: { kind: 'file', path: '/tmp/claude.jsonl', offset: 10 },
    fingerprint: 'claude-fingerprint',
    parserVersion: claudeManifest.parserVersion,
    payload: {
      entry,
      session: { nativeSessionId: 'session-claude', cwd: '/workspace' },
    },
  }
}

function historyContext(
  projects: string,
  checkpoints: Map<string, unknown>,
): SourceHistoryExecutionContext {
  return {
    installation: {
      id: 'installation-claude',
      hostId: 'host',
      productId: 'claude-code',
      dataRoot: projects,
      firstSeenAt: '2026-09-11T00:00:00.000Z',
      lastSeenAt: '2026-09-11T00:00:00.000Z',
    },
    abortSignal: new AbortController().signal,
    checkpoint: {
      async get<T>(key: string) { return (checkpoints.get(key) as T | undefined) ?? null },
      async set<T>(key: string, value: T) { checkpoints.set(key, structuredClone(value)) },
      async clear(key: string) { checkpoints.delete(key) },
    },
  } as SourceHistoryExecutionContext
}

test('Claude assistant entry separates native entry identity from derived thinking/tool facts', async () => {
  const normalized = await normalizeClaudeRecord(record({
    type: 'assistant',
    uuid: 'assistant-entry',
    message: {
      content: [
        { type: 'text', text: 'visible answer' },
        { type: 'thinking', thinking: 'visible thinking' },
        { type: 'tool_use', name: 'Bash', input: { command: 'pwd' } },
      ],
    },
  }, 'assistant-entry'), {} as never)

  const message = normalized.observations.find(item => item.kind === 'message.assistant')
  const reasoning = normalized.observations.find(item => item.kind === 'message.reasoning')
  const call = normalized.observations.find(item => item.kind === 'tool.call')
  assert.ok(message)
  assert.ok(reasoning)
  assert.ok(call)

  assert.equal(message.nativeEventId, 'assistant-entry')
  assert.equal(reasoning.nativeEventId, undefined)
  assert.equal(reasoning.dedupHints?.sharedEventKey, 'claude-reasoning:claude-record-contract')
  assert.equal(call.nativeEventId, undefined)
  assert.equal(call.nativeCallId, undefined)
  assert.equal(call.dedupHints?.sharedEventKey, 'claude-call:claude-record-contract:2')
  assert.equal((call.payload as { callId?: string }).callId, undefined)
})

test('Claude real tool_use id is nativeCallId but never doubles as nativeEventId', async () => {
  const normalized = await normalizeClaudeRecord(record({
    type: 'assistant',
    uuid: 'assistant-entry',
    message: {
      content: [{ type: 'tool_use', id: 'tool-native-1', name: 'Bash', input: { command: 'pwd' } }],
    },
  }, 'assistant-entry'), {} as never)

  const call = normalized.observations[0]
  assert.equal(call?.kind, 'tool.call')
  assert.equal(call?.nativeCallId, 'tool-native-1')
  assert.equal(call?.nativeEventId, undefined)
  assert.equal(call?.dedupHints?.nativeEventId, undefined)
})

test('Claude tool result without tool_use_id remains unpaired and non-native', async () => {
  const normalized = await normalizeClaudeRecord(record({
    type: 'user',
    uuid: 'result-entry',
    message: {
      content: [{ type: 'tool_result', content: 'done', is_error: false }],
    },
  }, 'result-entry'), {} as never)

  const result = normalized.observations.find(item => item.kind === 'tool.result')
  assert.ok(result)
  assert.equal(result.nativeEventId, undefined)
  assert.equal(result.nativeCallId, undefined)
  assert.equal(result.dedupHints?.sharedEventKey, 'claude-result:claude-record-contract:0')
})

test('Claude runtime tool_use_id is native call identity, not SourceRecord event identity', async () => {
  const envelope = claudeInternals.parseRuntimeEnvelope(JSON.stringify({
    id: 'agent-lens-envelope',
    capturedAt: '2026-09-11T00:00:00.000Z',
    event: {
      hook_event_name: 'PreToolUse',
      session_id: 'session-claude',
      tool_use_id: 'tool-native-1',
      tool_name: 'Bash',
    },
  }), 'event.json')
  const value = claudeInternals.runtimeRecord(envelope, '/tmp/event.json', {
    installation: {
      id: 'installation-claude',
      hostId: 'host',
      productId: 'claude-code',
      firstSeenAt: '2026-09-11T00:00:00.000Z',
      lastSeenAt: '2026-09-11T00:00:00.000Z',
    },
    abortSignal: new AbortController().signal,
  } as SourceExecutionContext)
  assert.equal(value.nativeId, undefined)

  const normalized = await normalizeClaudeRecord(value, {} as never)
  assert.equal(normalized.observations[0]?.nativeCallId, 'tool-native-1')
  assert.equal(normalized.observations[0]?.nativeEventId, undefined)
})

test('Claude normalizer leaves generic text bounding to central CapturePolicy', async () => {
  const text = 'x'.repeat(70_000)
  const normalized = await normalizeClaudeRecord(record({
    type: 'user',
    uuid: 'long-message',
    message: { content: text },
  }, 'long-message'), {} as never)
  assert.equal((normalized.observations[0]?.payload as { text?: string }).text?.length, text.length)
})

test('Claude EOF partial JSON is not consumed and is reconstructed after append', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-claude-partial-'))
  const projects = join(root, 'projects')
  const path = join(projects, 'demo', 'session.jsonl')
  await mkdir(dirname(path), { recursive: true })
  const first = JSON.stringify({
    type: 'user',
    sessionId: 'session-claude',
    uuid: 'user-1',
    message: { content: 'first' },
  })
  const partial = '{"type":"user","sessionId":"session-claude","uuid":"user-2","message":{"content":"sec'
  await writeFile(path, `${first}\n${partial}`, 'utf8')
  const checkpoints = new Map<string, unknown>()
  const ctx = historyContext(projects, checkpoints)

  try {
    const firstPass = []
    for await (const item of ingestClaudeHistory(ctx)) firstPass.push(item)
    assert.equal(firstPass.length, 1)
    const checkpoint = checkpoints.get(claudeInternals.historyCheckpointKey(path)) as {
      offset: number
      sequence: number
      fileId?: string
    }
    assert.equal(checkpoint.offset, Buffer.byteLength(first) + 1)
    assert.equal(checkpoint.sequence, 1)
    assert.ok(checkpoint.fileId)

    await appendFile(path, 'ond"}}\n', 'utf8')
    const secondPass = []
    for await (const item of ingestClaudeHistory(ctx)) secondPass.push(item)
    assert.equal(secondPass.length, 1)
    assert.equal(secondPass[0]?.nativeId, 'user-2')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Claude legacy checkpoint gains file identity without replaying unchanged history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-claude-file-id-'))
  const projects = join(root, 'projects')
  const path = join(projects, 'session.jsonl')
  await mkdir(projects, { recursive: true })
  const line = JSON.stringify({
    type: 'user',
    sessionId: 'session-claude',
    uuid: 'user-1',
    message: { content: 'hello' },
  })
  await writeFile(path, `${line}\n`, 'utf8')
  const meta = await stat(path)
  const checkpoints = new Map<string, unknown>([[
    claudeInternals.historyCheckpointKey(path),
    {
      path,
      offset: meta.size,
      sequence: 1,
      size: meta.size,
      mtimeMs: meta.mtimeMs,
    },
  ]])
  const ctx = historyContext(projects, checkpoints)

  try {
    const records = []
    for await (const item of ingestClaudeHistory(ctx)) records.push(item)
    assert.deepEqual(records, [])
    const checkpoint = checkpoints.get(claudeInternals.historyCheckpointKey(path)) as { fileId?: string }
    assert.ok(checkpoint.fileId)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Claude static assets remain partial and do not claim runtime discoverability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-claude-assets-contract-'))
  await mkdir(join(root, 'skills', 'reviewer'), { recursive: true })
  await writeFile(join(root, 'skills', 'reviewer', 'SKILL.md'), '# Reviewer\n', 'utf8')
  await writeFile(join(root, 'settings.json'), JSON.stringify({
    mcpServers: { docs: { command: 'node' } },
    hooks: { PreToolUse: [{ hooks: [{ command: 'check' }] }] },
  }), 'utf8')

  try {
    const assets = []
    for await (const asset of discoverClaudeAssets({
      installation: {
        id: 'installation-claude',
        hostId: 'host',
        productId: 'claude-code',
        configRoot: root,
        firstSeenAt: '2026-09-11T00:00:00.000Z',
        lastSeenAt: '2026-09-11T00:00:00.000Z',
      },
      abortSignal: new AbortController().signal,
    } as SourceExecutionContext)) assets.push(asset)

    const skill = assets.find(asset => asset.definition.type === 'skill')
    const mcp = assets.find(asset => asset.definition.type === 'mcp')
    const hook = assets.find(asset => asset.definition.type === 'hook')
    assert.equal(skill?.states?.find(state => state.state === 'discoverable')?.value, 'unknown')
    assert.equal(mcp?.states?.find(state => state.state === 'discoverable')?.value, 'unknown')
    assert.equal(hook?.states?.find(state => state.state === 'enabled')?.value, 'unknown')

    const capabilities = await declareClaudeCapabilities({} as never)
    assert.equal(capabilities.find(item => item.name === 'asset-discovery')?.status, 'partial')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Claude sessionless runtime hook remains evidence-only', async () => {
  const envelope = claudeInternals.parseRuntimeEnvelope(JSON.stringify({
    id: 'agent-lens-sessionless-envelope',
    capturedAt: '2026-09-11T00:00:00.000Z',
    event: {
      hook_event_name: 'PreToolUse',
      tool_use_id: 'tool-sessionless',
      tool_name: 'Bash',
    },
  }), 'sessionless.json')
  const value = claudeInternals.runtimeRecord(envelope, '/tmp/sessionless.json', {
    installation: {
      id: 'installation-claude',
      hostId: 'host',
      productId: 'claude-code',
      firstSeenAt: '2026-09-11T00:00:00.000Z',
      lastSeenAt: '2026-09-11T00:00:00.000Z',
    },
    abortSignal: new AbortController().signal,
  } as SourceExecutionContext)

  assert.equal(value.sourceSessionNativeId, undefined)
  const normalized = await normalizeClaudeRecord(value, {} as never)
  assert.deepEqual(normalized.observations, [])
  assert.equal(normalized.evidenceCandidates.length, 1)
})
