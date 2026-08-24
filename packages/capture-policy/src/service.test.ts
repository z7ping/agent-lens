import assert from 'node:assert/strict'
import test from 'node:test'
import type { NormalizedSourceOutput, SourceRecord } from '@agent-lens/core'
import {
  DefaultCapturePolicyService,
  NOT_CAPTURED,
  REDACTED,
  capturePolicySettingsFromEnv,
} from './service'

function settings(overrides: Partial<ReturnType<typeof capturePolicySettingsFromEnv>> = {}) {
  return {
    prompt: 'redacted' as const,
    tool: 'redacted' as const,
    config: 'redacted' as const,
    environment: 'off' as const,
    ...overrides,
  }
}

function record(payload: unknown): SourceRecord {
  return {
    id: 'record-1',
    sourceId: 'test',
    installationId: 'installation-1',
    nativeType: 'message',
    capturedAt: '2026-08-24T10:00:00.000Z',
    locator: { kind: 'external' },
    payload,
    parserVersion: '1',
  }
}

function normalized(kind: 'message.user' | 'tool.call', payload: unknown): NormalizedSourceOutput {
  return {
    observations: [{
      kind,
      capturedAt: '2026-08-24T10:00:00.000Z',
      payload,
      identityHints: { nativeSessionId: 'session-1' },
    }],
    evidenceCandidates: [],
  }
}

test('uses conservative 0.x-compatible defaults', () => {
  assert.deepEqual(capturePolicySettingsFromEnv({}), {
    prompt: 'redacted',
    tool: 'redacted',
    config: 'redacted',
    environment: 'off',
  })
})

test('redacted masks credentials and local user path', () => {
  const policy = new DefaultCapturePolicyService(settings())
  const result = policy.capture('tool', {
    authorization: 'Bearer abcdefghijklmnop',
    refreshToken: 'opaque-value-that-does-not-look-like-a-token',
    command: 'cat C:\\Users\\alice\\secret.txt',
  })
  assert.equal((result.value as Record<string, unknown>).authorization, REDACTED)
  assert.equal((result.value as Record<string, unknown>).refreshToken, REDACTED)
  assert.match(String((result.value as Record<string, unknown>).command), /Users\\\[用户\]/)
})

test('full keeps ordinary content but still protects explicit credentials', () => {
  const policy = new DefaultCapturePolicyService(settings({ tool: 'full' }))
  const result = policy.capture('tool', {
    path: 'C:\\Users\\alice\\project\\file.txt',
    token: 'ghp_abcdefghijklmnopqrstuvwxyz',
  })
  assert.equal((result.value as Record<string, unknown>).path, 'C:\\Users\\alice\\project\\file.txt')
  assert.equal((result.value as Record<string, unknown>).token, REDACTED)
})

test('prompt off persists event shape without source text', () => {
  const policy = new DefaultCapturePolicyService(settings({ prompt: 'off' }))
  const source = record({ content: 'private prompt' })
  const output = normalized('message.user', { text: 'private prompt' })
  assert.equal(policy.sanitizeSourceRecord(source, output).payload, null)
  const safe = policy.sanitizeNormalizedOutput(output)
  assert.deepEqual(safe.observations[0]?.payload, { capturePolicy: 'off', text: NOT_CAPTURED })
})

test('tool off keeps aggregation metadata and drops arguments', () => {
  const policy = new DefaultCapturePolicyService(settings({ tool: 'off' }))
  const output = normalized('tool.call', {
    nativeToolName: 'shell',
    status: 'success',
    command: 'cat ~/.ssh/config',
    input: { path: '~/.ssh/config' },
  })
  const safe = policy.sanitizeNormalizedOutput(output)
  assert.deepEqual(safe.observations[0]?.payload, {
    capturePolicy: 'off',
    nativeToolName: 'shell',
    status: 'success',
  })
})

test('config off prevents static assets from entering persistence', () => {
  const policy = new DefaultCapturePolicyService(settings({ config: 'off' }))
  assert.equal(policy.sanitizeDiscoveredAsset({
    definition: { type: 'skill', canonicalName: 'example' },
    binding: { path: '/home/alice/.agent/skills/example' },
  }), null)
})

test('config off strips normalized asset hints as well as static discovery', () => {
  const policy = new DefaultCapturePolicyService(settings({ config: 'off' }))
  const output: NormalizedSourceOutput = {
    observations: [],
    evidenceCandidates: [],
    assetHints: [{ token: 'opaque-config-secret', name: 'example' }],
  }
  assert.deepEqual(policy.sanitizeNormalizedOutput(output).assetHints, [])
})
