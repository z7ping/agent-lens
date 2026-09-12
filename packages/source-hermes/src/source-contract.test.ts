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

test('Hermes user assets follow profile semantics and explicit scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-hermes-contract-'))
  await mkdir(join(root, 'plugins', 'alpha'), { recursive: true })
  await mkdir(join(root, 'plugins', 'junk'), { recursive: true })
  await mkdir(join(root, 'skills', 'reviewer'), { recursive: true })
  await mkdir(join(root, 'memories'), { recursive: true })
  await writeFile(join(root, 'plugins', 'alpha', 'plugin.yaml'), [
    'name: alpha',
    'version: 1.2.3',
    '',
  ].join('\n'), 'utf8')
  await writeFile(join(root, 'plugins', 'alpha', '__init__.py'), '# plugin\n', 'utf8')
  await writeFile(join(root, 'plugins', 'junk', 'README.md'), '# not a plugin\n', 'utf8')
  await writeFile(join(root, 'skills', 'reviewer', 'SKILL.md'), '# reviewer\n', 'utf8')
  await writeFile(join(root, 'memories', 'MEMORY.md'), 'Remember this\n', 'utf8')
  await writeFile(join(root, 'memories', 'USER.md'), 'User profile\n', 'utf8')
  await writeFile(join(root, 'memories', 'junk.md'), 'not a Hermes built-in memory slot\n', 'utf8')
  await writeFile(join(root, 'SOUL.md'), '# Persona\n', 'utf8')
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
      checkpoint: {
        async get() { return undefined },
        async set() {},
      },
    } as unknown as SourceExecutionContext

    for await (const asset of discoverHermesAssets(ctx)) assets.push(asset)

    const configMcp = (name: string) => assets.find(asset =>
      asset.definition.type === 'mcp'
      && asset.definition.canonicalName === name
      && asset.binding?.source === 'hermes:config:mcp')
    const plugin = (name: string) => assets.find(asset =>
      asset.definition.type === 'plugin'
      && asset.definition.canonicalName === name)
    const definitionNames = new Set(assets.map(asset =>
      `${asset.definition.type}:${asset.definition.canonicalName}`))

    assert.equal(configMcp('docs')?.states?.find(state => state.state === 'enabled')?.value, true)
    assert.equal(configMcp('docs')?.states?.find(state => state.state === 'discoverable')?.value, 'unknown')
    assert.equal(configMcp('disabled')?.states?.find(state => state.state === 'enabled')?.value, false)
    assert.equal(configMcp('disabled')?.states?.find(state => state.state === 'discoverable')?.value, false)

    assert.equal(plugin('alpha')?.binding?.source, 'hermes:user-plugin')
    assert.equal(plugin('alpha')?.states?.find(state => state.state === 'installed')?.value, true)
    assert.equal(plugin('alpha')?.states?.find(state => state.state === 'enabled')?.value, true)
    assert.equal(plugin('beta')?.states?.find(state => state.state === 'installed')?.value, 'unknown')
    assert.equal(plugin('beta')?.states?.find(state => state.state === 'enabled')?.value, false)
    assert.equal(plugin('both')?.states?.find(state => state.state === 'enabled')?.value, false)
    assert.equal(definitionNames.has('plugin:junk'), false)

    assert.equal(definitionNames.has('skill:reviewer'), true)
    assert.equal(definitionNames.has('memory:hermes:memory.md'), true)
    assert.equal(definitionNames.has('memory:hermes:user.md'), true)
    assert.equal(definitionNames.has('memory:hermes:junk.md'), false)
    assert.equal(definitionNames.has('context:hermes-soul'), true)

    const userBindings = assets
      .flatMap(asset => asset.binding ? [asset.binding] : [])
      .filter(binding => binding.scope !== 'project')
    assert.ok(userBindings.length > 0)
    assert.equal(userBindings.every(binding => binding.scope === 'user'), true)
    assert.equal(userBindings.every(binding => binding.scopeRoot === root), true)

    const capabilities = await declareHermesCapabilities({} as never)
    assert.equal(capabilities.find(item => item.name === 'asset-discovery')?.status, 'partial')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Hermes project context follows current first-type-wins and AGENTS chain semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-hermes-profile-'))
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-lens-hermes-project-'))
  const packageDir = join(projectRoot, 'packages')
  const cwd = join(packageDir, 'web')

  await mkdir(join(projectRoot, '.git'), { recursive: true })
  await mkdir(cwd, { recursive: true })
  await writeFile(join(projectRoot, 'AGENTS.md'), '# root instructions\n', 'utf8')
  await writeFile(join(packageDir, 'AGENTS.override.md'), '# package override\n', 'utf8')
  await writeFile(join(cwd, 'AGENTS.override.md'), '   \n', 'utf8')
  await writeFile(join(cwd, 'AGENTS.md'), '# cwd instructions\n', 'utf8')
  await writeFile(join(cwd, 'CLAUDE.md'), '# should lose to AGENTS\n', 'utf8')

  const checkpoint = {
    async get<T>(key: string): Promise<T | undefined> {
      return key === 'hermes:known-project-cwds:v1' ? [cwd] as T : undefined
    },
    async set() {},
  }

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
    checkpoint,
  } as unknown as SourceExecutionContext

  try {
    const first = []
    for await (const asset of discoverHermesAssets(ctx)) {
      if (asset.binding?.scope === 'project') first.push(asset)
    }

    assert.deepEqual(
      first.map(asset => asset.binding?.path),
      [
        join(projectRoot, 'AGENTS.md'),
        join(packageDir, 'AGENTS.override.md'),
        join(cwd, 'AGENTS.md'),
      ],
    )
    assert.equal(first.every(asset => asset.binding?.scopeRoot === projectRoot), true)
    assert.equal(first.every(asset =>
      asset.states?.some(state => state.state === 'discoverable' && state.value === 'unknown')), true)
    assert.equal(first.some(asset => asset.binding?.path === join(cwd, 'CLAUDE.md')), false)

    await writeFile(join(packageDir, '.hermes.md'), '# Hermes-specific instructions\n', 'utf8')
    const second = []
    for await (const asset of discoverHermesAssets(ctx)) {
      if (asset.binding?.scope === 'project') second.push(asset)
    }
    assert.deepEqual(second.map(asset => asset.binding?.path), [join(packageDir, '.hermes.md')])
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(projectRoot, { recursive: true, force: true })
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

test('Hermes sessionless source record is preserved as evidence without synthetic observation session', async () => {
  const sessionless = record({
    runtimeEvent: {
      hook_event_name: 'pre_tool_call',
      tool_name: 'terminal',
      args: { command: 'pwd' },
    },
    session: {},
    captureChannel: 'runtime-hook',
  }, {
    nativeType: 'hook/pre_tool_call',
    locator: { kind: 'runtime-hook', path: '/tmp/hook.json', hookEventId: 'envelope' },
  })
  delete sessionless.sourceSessionNativeId
  const normalized = await normalizeHermesRecord(sessionless, {} as never)

  assert.deepEqual(normalized.observations, [])
  assert.equal(normalized.evidenceCandidates.length, 1)
})
