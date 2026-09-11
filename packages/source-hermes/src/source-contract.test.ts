import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SourceExecutionContext, SourceRecord } from '@agent-lens/core'
import {
  declareHermesCapabilities,
  discoverHermesAssets,
  normalizeHermesRecord,
} from './index'

function record(payload: unknown, options: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: 'hermes-record-contract',
    sourceId: 'hermes',
    installationId: 'installation-hermes',
    sourceSessionNativeId: 'session-hermes',
    nativeType: 'message/assistant',
    sourceSequence: 100,
    capturedAt: '2026-09-11T00:00:00.000Z',
    locator: { kind: 'database', path: '/tmp/state.db', table: 'messages', rowId: '1' },
    fingerprint: 'hermes-fingerprint',
    parserVersion: '3',
    payload,
    ...options,
  }
}

test('Hermes missing message/tool ids stay internal instead of becoming native identity', async () => {
  const normalized = await normalizeHermesRecord(record({
    message: {
      role: 'assistant',
      raw_content: 'hello',
      tool_calls: [{ function: { name: 'terminal', arguments: '{"command":"pwd"}' } }],
    },
    session: { nativeSessionId: 'session-hermes' },
    captureChannel: 'history',
  }), {} as never)

  const assistant = normalized.observations.find(item => item.kind === 'message.assistant')
  const call = normalized.observations.find(item => item.kind === 'tool.call')
  assert.ok(assistant)
  assert.ok(call)
  assert.equal(assistant.nativeEventId, undefined)
  assert.equal(call.nativeEventId, undefined)
  assert.equal(call.nativeCallId, undefined)
  assert.equal(call.dedupHints?.nativeCallId, undefined)
  assert.equal(call.dedupHints?.sharedEventKey, 'hermes-call:hermes-record-contract:1')
  assert.equal(normalized.evidenceCandidates[0]?.nativeStableId, undefined)
})

test('Hermes hook request metadata may correlate internally without fabricating nativeCallId', async () => {
  const normalized = await normalizeHermesRecord(record({
    runtimeEvent: {
      hook_event_name: 'pre_tool_call',
      session_id: 'session-hermes',
      api_request_id: 'request-1',
      api_call_count: 2,
      tool_name: 'terminal',
      args: { command: 'pwd' },
    },
    session: { nativeSessionId: 'session-hermes' },
    captureChannel: 'runtime-hook',
  }, {
    nativeType: 'hook/pre_tool_call',
    locator: { kind: 'runtime-hook', path: '/tmp/hook.json', hookEventId: 'internal-envelope' },
  }), {} as never)

  const call = normalized.observations[0]
  assert.equal(call?.kind, 'tool.call')
  assert.equal(call?.nativeCallId, undefined)
  assert.equal(call?.nativeEventId, undefined)
  assert.equal(call?.dedupHints?.sharedEventKey, 'hermes-hook:request-1:2:terminal')
})

test('Hermes config uses real YAML semantics and evidence-driven plugin/MCP states', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-hermes-contract-'))
  await mkdir(join(root, 'plugins', 'alpha'), { recursive: true })
  await mkdir(join(root, 'plugins', 'beta'), { recursive: true })
  await writeFile(join(root, 'config.yaml'), [
    'mcp_servers:',
    '  docs:',
    '    command: node',
    '  disabled:',
    '    command: node',
    '    enabled: false',
    'plugins:',
    '  enabled:',
    '    - alpha',
    '    - both',
    '  disabled:',
    '    - beta',
    '    - both',
    'toolsets:',
    '  - hermes-cli',
    '',
  ].join('\n'), 'utf8')

  try {
    const assets = []
    const ctx = {
      installation: {
        id: 'installation-hermes',
        hostId: 'host',
        productId: 'hermes',
        configRoot: root,
        dataRoot: root,
        firstSeenAt: '2026-09-11T00:00:00.000Z',
        lastSeenAt: '2026-09-11T00:00:00.000Z',
      },
      abortSignal: new AbortController().signal,
    } as SourceExecutionContext

    for await (const asset of discoverHermesAssets(ctx)) assets.push(asset)

    const configMcp = (name: string) => assets.find(asset =>
      asset.definition.type === 'mcp'
      && asset.definition.canonicalName === name
      && asset.binding?.source === 'hermes:config')
    const pluginConfig = (name: string) => assets.find(asset =>
      asset.definition.type === 'plugin'
      && asset.definition.canonicalName === name
      && asset.binding?.source === 'hermes:config')

    assert.equal(configMcp('docs')?.states?.find(state => state.state === 'enabled')?.value, true)
    assert.equal(configMcp('docs')?.states?.find(state => state.state === 'discoverable')?.value, 'unknown')
    assert.equal(configMcp('disabled')?.states?.find(state => state.state === 'enabled')?.value, false)
    assert.equal(configMcp('disabled')?.states?.find(state => state.state === 'discoverable')?.value, false)

    assert.equal(pluginConfig('alpha')?.states?.find(state => state.state === 'enabled')?.value, true)
    assert.equal(pluginConfig('beta')?.states?.find(state => state.state === 'enabled')?.value, false)
    assert.equal(pluginConfig('both')?.states?.find(state => state.state === 'enabled')?.value, false)

    const capabilities = await declareHermesCapabilities({} as never)
    assert.equal(capabilities.find(item => item.name === 'asset-discovery')?.status, 'partial')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Hermes parser replay ignores legacy row fallback nativeId and recovers raw message identity', async () => {
  const legacySynthetic = await normalizeHermesRecord(record({
    message: {
      id: null,
      role: 'user',
      raw_content: 'legacy',
    },
    session: { nativeSessionId: 'session-hermes' },
    captureChannel: 'history',
  }, {
    nativeId: 'row-42',
    locator: { kind: 'database', path: '/tmp/state.db', table: 'messages', rowId: '42' },
  }), {} as never)

  assert.equal(legacySynthetic.observations[0]?.nativeEventId, undefined)
  assert.equal(legacySynthetic.evidenceCandidates[0]?.nativeStableId, undefined)

  const realNative = await normalizeHermesRecord(record({
    message: {
      id: 123,
      role: 'user',
      raw_content: 'real',
    },
    session: { nativeSessionId: 'session-hermes' },
    captureChannel: 'history',
  }, {
    nativeId: 'legacy-value-that-must-not-win',
  }), {} as never)

  assert.equal(realNative.observations[0]?.nativeEventId, '123')
  assert.equal(realNative.evidenceCandidates[0]?.nativeStableId, '123')
})

