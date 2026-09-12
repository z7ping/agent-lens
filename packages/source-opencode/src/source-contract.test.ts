import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import type { SourceExecutionContext, SourceRecord } from '@agent-lens/core'
import {
  declareOpenCodeCapabilities,
  discoverOpenCodeAssets,
  normalizeOpenCodeRecord,
  openCodeSourceInternals,
} from './index'

function record(part: Record<string, unknown>, message: Record<string, unknown>, nativeId?: string): SourceRecord {
  return {
    id: 'opencode-record-contract',
    sourceId: 'opencode',
    installationId: 'installation-opencode',
    sourceSessionNativeId: 'session-opencode',
    nativeType: `part/${String(part.type ?? 'unknown')}`,
    ...(nativeId ? { nativeId } : {}),
    sourceSequence: 100,
    capturedAt: '2026-09-11T00:00:00.000Z',
    locator: { kind: 'database', path: '/tmp/opencode.db', table: 'part', rowId: '1' },
    fingerprint: 'opencode-fingerprint',
    parserVersion: '3',
    payload: {
      part,
      message,
      session: { nativeSessionId: 'session-opencode' },
      captureChannel: 'history',
    },
  }
}

test('OpenCode tool part id never substitutes for missing native call id', async () => {
  const normalized = await normalizeOpenCodeRecord(record({
    type: 'tool',
    tool: 'bash',
    state: {
      status: 'completed',
      input: { command: 'pwd' },
      output: '/tmp',
    },
  }, { role: 'assistant' }, 'part-native-id'), {} as never)

  assert.equal(normalized.observations.length, 2)
  const call = normalized.observations[0]!
  const result = normalized.observations[1]!
  assert.equal(call.kind, 'tool.call')
  assert.equal(result.kind, 'tool.result')
  assert.equal(call.nativeCallId, undefined)
  assert.equal(result.nativeCallId, undefined)
  assert.equal(call.nativeEventId, undefined)
  assert.equal(result.nativeEventId, undefined)
  assert.equal(call.dedupHints?.sharedEventKey, 'opencode-tool:opencode-record-contract')
  assert.equal(result.dedupHints?.sharedEventKey, 'opencode-tool:opencode-record-contract')
})

test('OpenCode missing Part id stays out of SourceRecord nativeId', () => {
  const value = openCodeSourceInternals.recordFromRow({
    row_id: 42,
    id: null,
    message_id: 'message-1',
    session_id: 'session-1',
    time_created: 1_787_000_000_000,
    data: JSON.stringify({ type: 'text', text: 'hello' }),
    message_data: JSON.stringify({ role: 'user' }),
    directory: '/workspace',
    session_title: 'title',
  }, {
    installation: {
      id: 'installation-opencode',
      hostId: 'host',
      productId: 'opencode',
      dataRoot: '/tmp',
      firstSeenAt: '2026-09-11T00:00:00.000Z',
      lastSeenAt: '2026-09-11T00:00:00.000Z',
    },
    abortSignal: new AbortController().signal,
  } as SourceExecutionContext, 'history')

  assert.equal(value.nativeId, undefined)
  assert.equal(value.locator.kind, 'database')
  assert.equal(value.locator.kind === 'database' ? value.locator.rowId : undefined, '42')
})

test('OpenCode normalizer leaves generic text bounding to central CapturePolicy', async () => {
  const text = 'x'.repeat(70_000)
  const normalized = await normalizeOpenCodeRecord(record(
    { type: 'text', text },
    { role: 'user' },
    'part-text-id',
  ), {} as never)

  assert.equal((normalized.observations[0]?.payload as { text?: string }).text?.length, text.length)
})

test('OpenCode asset discovery is partial and keeps runtime state conservative', async () => {
  const capabilities = await declareOpenCodeCapabilities({} as never)
  const assets = capabilities.find(item => item.name === 'asset-discovery')
  assert.equal(assets?.status, 'partial')
  assert.deepEqual(assets?.captureModes, ['static-scan'])
})

test('OpenCode parser replay neutralizes legacy row fallback nativeId', async () => {
  const legacy: SourceRecord = {
    ...record(
      { type: 'text', text: 'legacy' },
      { role: 'user' },
      'row-42',
    ),
    locator: { kind: 'database', path: '/tmp/opencode.db', table: 'part', rowId: '42' },
  }

  const normalized = await normalizeOpenCodeRecord(legacy, {} as never)
  assert.equal(normalized.observations[0]?.nativeEventId, undefined)
  assert.equal(normalized.evidenceCandidates[0]?.nativeStableId, undefined)
})

test('OpenCode sessionless row stays evidence-only instead of creating an unknown native session', async () => {
  const value = openCodeSourceInternals.recordFromRow({
    row_id: 99,
    id: 'part-99',
    message_id: 'message-99',
    session_id: null,
    time_created: 1_787_000_000_000,
    data: JSON.stringify({ type: 'text', text: 'orphan' }),
    message_data: JSON.stringify({ role: 'user' }),
    directory: null,
    session_title: null,
  }, {
    installation: {
      id: 'installation-opencode',
      hostId: 'host',
      productId: 'opencode',
      dataRoot: '/tmp',
      firstSeenAt: '2026-09-11T00:00:00.000Z',
      lastSeenAt: '2026-09-11T00:00:00.000Z',
    },
    abortSignal: new AbortController().signal,
  } as SourceExecutionContext, 'history')

  assert.equal(value.sourceSessionNativeId, undefined)
  const normalized = await normalizeOpenCodeRecord(value, {} as never)
  assert.deepEqual(normalized.observations, [])
  assert.equal(normalized.evidenceCandidates.length, 1)
})


test('OpenCode V2 assets parse JSONC and preserve user/project scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-opencode-assets-'))
  const configRoot = join(root, 'config', 'opencode')
  const projectRoot = join(root, 'workspace')
  const cwd = join(projectRoot, 'packages', 'web')
  const packageDir = dirname(cwd)

  await mkdir(join(projectRoot, '.git'), { recursive: true })
  await mkdir(cwd, { recursive: true })
  await mkdir(configRoot, { recursive: true })
  await mkdir(join(configRoot, 'skills', 'global-review'), { recursive: true })
  await mkdir(join(projectRoot, '.opencode', 'skills', 'root-review'), { recursive: true })
  await mkdir(join(packageDir, '.opencode', 'skills', 'package-review'), { recursive: true })
  await mkdir(join(projectRoot, '.opencode', 'agents'), { recursive: true })
  await mkdir(join(projectRoot, '.opencode', 'commands'), { recursive: true })
  await mkdir(join(projectRoot, '.opencode', 'plugins'), { recursive: true })

  await writeFile(join(configRoot, 'AGENTS.md'), '# global instructions\n', 'utf8')
  await writeFile(join(projectRoot, 'AGENTS.md'), '# project instructions\n', 'utf8')
  await writeFile(join(packageDir, 'AGENTS.md'), '# package instructions\n', 'utf8')
  await writeFile(join(configRoot, 'skills', 'global-review', 'SKILL.md'), '# global skill\n', 'utf8')
  await writeFile(join(projectRoot, '.opencode', 'skills', 'root-review', 'SKILL.md'), '# root skill\n', 'utf8')
  await writeFile(join(packageDir, '.opencode', 'skills', 'package-review', 'SKILL.md'), '# package skill\n', 'utf8')
  await writeFile(join(projectRoot, '.opencode', 'agents', 'reviewer.md'), '# reviewer\n', 'utf8')
  await writeFile(join(projectRoot, '.opencode', 'commands', 'ship.md'), '# ship\n', 'utf8')
  await writeFile(join(projectRoot, '.opencode', 'plugins', 'notify.ts'), 'export const Notify = () => ({})\n', 'utf8')

  await writeFile(join(configRoot, 'opencode.jsonc'), [
    '{',
    '  // global JSONC must parse without hand-written comment stripping',
    '  "mcp": {',
    '    "docs": { "type": "local", "command": ["node"] },',
    '    "off": { "type": "local", "command": ["node"], "disabled": true },',
    '    "legacy-off": { "type": "local", "command": ["node"], "enabled": false },',
    '  },',
    '  "agents": { "reviewer": {} },',
    '  "commands": { "doctor": {} },',
    '  "plugins": ["pkg-one", { "package": "@scope/pkg-two" }],',
    '}',
    '',
  ].join('\n'), 'utf8')
  await writeFile(join(projectRoot, 'opencode.jsonc'), [
    '{',
    '  "mcp": { "project-docs": { "type": "local", "command": ["node"] } },',
    '  "plugin": ["legacy-compatible-plugin"],',
    '}',
    '',
  ].join('\n'), 'utf8')

  const ctx = {
    installation: {
      id: 'installation-opencode',
      hostId: 'host',
      productId: 'opencode',
      configRoot,
      dataRoot: join(root, 'data'),
      firstSeenAt: '2026-09-12T00:00:00.000Z',
      lastSeenAt: '2026-09-12T00:00:00.000Z',
    },
    abortSignal: new AbortController().signal,
    checkpoint: {
      async get<T>(key: string): Promise<T | undefined> {
        return key === 'opencode:known-project-cwds:v1'
          ? [cwd] as unknown as T
          : undefined
      },
      async set() {},
    },
  } as unknown as SourceExecutionContext

  try {
    const assets = []
    for await (const asset of discoverOpenCodeAssets(ctx)) assets.push(asset)

    const paths = new Set(assets.flatMap(asset => asset.binding?.path ? [asset.binding.path] : []))
    assert.equal(paths.has(join(configRoot, 'AGENTS.md')), true)
    assert.equal(paths.has(join(projectRoot, 'AGENTS.md')), true)
    assert.equal(paths.has(join(packageDir, 'AGENTS.md')), true)
    assert.equal(paths.has(join(projectRoot, '.opencode', 'skills', 'root-review')), true)
    assert.equal(paths.has(join(packageDir, '.opencode', 'skills', 'package-review')), true)
    assert.equal(paths.has(join(projectRoot, '.opencode', 'agents', 'reviewer.md')), true)
    assert.equal(paths.has(join(projectRoot, '.opencode', 'commands', 'ship.md')), true)
    assert.equal(paths.has(join(projectRoot, '.opencode', 'plugins', 'notify.ts')), true)

    const globalInstruction = assets.find(asset => asset.binding?.path === join(configRoot, 'AGENTS.md'))
    const projectInstruction = assets.find(asset => asset.binding?.path === join(projectRoot, 'AGENTS.md'))
    assert.equal(globalInstruction?.binding?.scope, 'user')
    assert.equal(projectInstruction?.binding?.scope, 'project')
    assert.equal(projectInstruction?.binding?.scopeRoot, projectRoot)
    assert.equal(projectInstruction?.states?.find(state => state.state === 'discoverable')?.value, 'unknown')

    const mcp = (name: string) => assets.find(asset =>
      asset.definition.type === 'mcp' && asset.definition.canonicalName === name)
    assert.equal(mcp('docs')?.binding?.scope, 'user')
    assert.equal(mcp('docs')?.states?.find(state => state.state === 'enabled')?.value, 'unknown')
    assert.equal(mcp('off')?.states?.find(state => state.state === 'enabled')?.value, false)
    assert.equal(mcp('off')?.states?.find(state => state.state === 'discoverable')?.value, false)
    assert.equal(mcp('legacy-off')?.states?.find(state => state.state === 'enabled')?.value, false)
    assert.equal(mcp('project-docs')?.binding?.scope, 'project')

    const configuredPlugins = assets.filter(asset =>
      asset.definition.type === 'plugin'
      && asset.states?.some(state => state.state === 'configured' && state.value === true))
    assert.ok(configuredPlugins.some(asset => asset.definition.canonicalName === 'pkg-one'))
    assert.ok(configuredPlugins.some(asset => asset.definition.canonicalName === '@scope/pkg-two'))
    assert.ok(configuredPlugins.some(asset => asset.definition.canonicalName === 'legacy-compatible-plugin'))
    assert.equal(
      configuredPlugins.find(asset => asset.definition.canonicalName === 'pkg-one')
        ?.states?.find(state => state.state === 'installed')?.value,
      'unknown',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
