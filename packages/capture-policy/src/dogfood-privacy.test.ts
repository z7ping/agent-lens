import assert from 'node:assert/strict'
import test from 'node:test'
import type { NormalizedSourceOutput, SourceRecord } from '@agent-lens/core'
import { DefaultCapturePolicyService, REDACTED } from './service'

function policy() {
  return new DefaultCapturePolicyService({
    prompt: 'redacted',
    tool: 'redacted',
    config: 'redacted',
    environment: 'off',
    enabledSources: ['dsh', 'codex', 'claude-code', 'pi', 'hermes', 'opencode'],
  })
}

function sourceRecord(payload: unknown): SourceRecord {
  return {
    id: 'dsh-record-1',
    sourceId: 'dsh',
    installationId: 'dsh-installation',
    sourceSessionNativeId: 'session-1',
    nativeType: 'request/header',
    capturedAt: '2026-08-25T10:00:00.000Z',
    locator: { kind: 'file', path: '/home/alice/.deepseek/dsh/session.jsonl' },
    payload,
    parserVersion: '2',
  }
}

test('DSH request header never persists explicit authorization or API tokens', () => {
  const service = policy()
  const record = sourceRecord({
    authorization: 'Bearer secret-token-value',
    headers: {
      'x-api-key': 'sk-proj-abcdefghijklmnopqrstuvwxyz',
      harmless: 'ok',
    },
    model: 'deepseek-chat',
  })
  const normalized: NormalizedSourceOutput = {
    observations: [{
      kind: 'model.call',
      capturedAt: record.capturedAt,
      payload: record.payload,
      identityHints: { nativeSessionId: 'session-1' },
    }],
    evidenceCandidates: [{
      captureMethod: 'native-log',
      derivation: 'reported',
      sourceRecordId: record.id,
      capturedAt: record.capturedAt,
      nativeStableId: 'request-1',
    }],
  }

  const safeRecord = service.sanitizeSourceRecord(record, normalized)
  const safeOutput = service.sanitizeNormalizedOutput(normalized)
  assert.equal((safeRecord.payload as any).authorization, REDACTED)
  assert.equal((safeRecord.payload as any).headers['x-api-key'], REDACTED)
  assert.equal((safeOutput.observations[0]?.payload as any).authorization, REDACTED)
  assert.equal((safeOutput.observations[0]?.payload as any).headers['x-api-key'], REDACTED)
  assert.equal((safeOutput.observations[0]?.payload as any).model, 'deepseek-chat')
})

test('MCP configuration redacts secret-shaped keys while retaining structural metadata', () => {
  const service = policy()
  const captured = service.capture('config', {
    name: 'filesystem',
    command: 'node',
    apiKey: 'opaque-secret-value',
    env: {
      ACCESS_TOKEN: 'another-secret-value',
      MODE: 'safe',
    },
  })
  assert.equal((captured.value as any).name, 'filesystem')
  assert.equal((captured.value as any).apiKey, REDACTED)
  assert.equal((captured.value as any).env.ACCESS_TOKEN, REDACTED)
  assert.equal((captured.value as any).env.MODE, 'safe')
})

test('environment scope is not captured by default dogfood privacy policy', () => {
  const service = policy()
  const captured = service.capture('environment', {
    PATH: '/usr/bin',
    HOME: '/home/alice',
    OPENAI_API_KEY: 'sk-proj-abcdefghijklmnopqrstuvwxyz',
  })
  assert.equal(captured.value, null)
  assert.equal(captured.mode, 'off')
})

test('raw tool payload and normalized payload both redact credentials', () => {
  const service = policy()
  const record: SourceRecord = {
    id: 'tool-record-1',
    sourceId: 'codex',
    installationId: 'codex-installation',
    sourceSessionNativeId: 'session-2',
    nativeType: 'tool/call',
    capturedAt: '2026-08-25T10:00:00.000Z',
    locator: { kind: 'runtime-hook', hookEventId: 'hook-1' },
    payload: {
      nativeToolName: 'shell',
      command: 'curl -H "Authorization: Bearer abcdefghijklmnop" https://example.test',
      token: 'ghp_abcdefghijklmnopqrstuvwxyz',
    },
    parserVersion: '1',
  }
  const normalized: NormalizedSourceOutput = {
    observations: [{
      kind: 'tool.call',
      capturedAt: record.capturedAt,
      payload: record.payload,
      identityHints: { nativeSessionId: 'session-2' },
    }],
    evidenceCandidates: [{
      captureMethod: 'runtime-hook',
      derivation: 'observed',
      sourceRecordId: record.id,
      capturedAt: record.capturedAt,
      sourceLocator: record.locator,
    }],
  }

  const safeRecordText = JSON.stringify(service.sanitizeSourceRecord(record, normalized))
  const safeOutputText = JSON.stringify(service.sanitizeNormalizedOutput(normalized))
  assert.equal(safeRecordText.includes('ghp_abcdefghijklmnopqrstuvwxyz'), false)
  assert.equal(safeOutputText.includes('ghp_abcdefghijklmnopqrstuvwxyz'), false)
  assert.equal(safeRecordText.includes('Bearer abcdefghijklmnop'), false)
  assert.equal(safeOutputText.includes('Bearer abcdefghijklmnop'), false)
})
