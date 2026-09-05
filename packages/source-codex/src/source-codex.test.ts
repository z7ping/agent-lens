import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import type {
  AgentInstallation,
  Host,
  SourceCheckpointService,
  SourceExecutionContext,
  SourceRecord,
} from '@agent-lens/core'
import {
  codexSourceDefinition,
  detectCodex,
} from './index'

class MemoryCheckpoint implements SourceCheckpointService {
  private readonly values = new Map<string, unknown>()

  async get<T>(key: string): Promise<T | null> {
    return (this.values.get(key) as T | undefined) ?? null
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value)
  }

  async clear(key: string): Promise<void> {
    this.values.delete(key)
  }
}

const host: Host = {
  id: 'host-1',
  name: 'test-host',
  platform: process.platform,
  arch: process.arch,
  createdAt: '2026-08-20T00:00:00.000Z',
  lastSeenAt: '2026-08-20T00:00:00.000Z',
}

async function withFixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-codex-'))
  const sessions = join(root, 'sessions')
  const fixturePath = join(sessions, '2026', '07', '02', 'rollout-test.jsonl')
  await mkdir(dirname(fixturePath), { recursive: true })
  const fixture = await readFile(new URL('./__fixtures__/codex-sample.jsonl', import.meta.url), 'utf8')
  await writeFile(fixturePath, fixture, 'utf8')
  return { root, sessions, fixturePath }
}

function installation(root: string, sessions: string): AgentInstallation {
  return {
    id: 'codex-install-1',
    hostId: host.id,
    productId: 'codex',
    configRoot: root,
    dataRoot: sessions,
    firstSeenAt: '2026-08-20T00:00:00.000Z',
    lastSeenAt: '2026-08-20T00:00:00.000Z',
  }
}

function sourceContext(root: string, sessions: string, checkpoint = new MemoryCheckpoint()): SourceExecutionContext {
  return {
    host,
    installation: installation(root, sessions),
    abortSignal: new AbortController().signal,
    checkpoint,
  }
}

test('detect uses CODEX_HOME without importing Prototype path logic', async () => {
  const { root, sessions } = await withFixture()
  try {
    const detected = await detectCodex({
      host,
      env: { CODEX_HOME: root, PATH: '' },
    })
    assert.equal(detected.length, 1)
    assert.equal(detected[0]?.sourceId, 'codex')
    assert.equal(detected[0]?.configRoot, root)
    assert.equal(detected[0]?.dataRoot, sessions)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('history ingest is incremental and preserves every native record', async () => {
  const { root, sessions } = await withFixture()
  const source = sourceContext(root, sessions)

  try {
    const first = []
    for await (const record of codexSourceDefinition.ingestHistory!(source)) first.push(record)
    assert.equal(first.length, 11)
    assert.equal(first[0]?.nativeType, 'metadata/session_start')
    assert.equal(first[0]?.sourceSessionNativeId, 'codex-test-1')
    assert.equal(first[2]?.nativeType, 'event_msg/task_started')

    const second = []
    for await (const record of codexSourceDefinition.ingestHistory!(source)) second.push(record)
    assert.equal(second.length, 0)

    const serialized = JSON.stringify(first)
    const sessionMeta = first.find(record => record.nativeType === 'session_meta')
    assert.equal((sessionMeta?.payload as any).entry.payload.future_field.nested, 'survives')
    assert.equal(serialized.includes('<permissions instructions>sandbox'), true)
    assert.equal(serialized.includes('<environment_context>'), true)
    assert.equal(serialized.includes('[redacted:injected-context]'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('history emits native title only on first discovery or thread_name change', async () => {
  const { root, sessions } = await withFixture()
  const source = sourceContext(root, sessions)
  const indexPath = join(root, 'session_index.jsonl')

  try {
    await writeFile(indexPath, JSON.stringify({
      id: 'codex-test-1',
      thread_name: '第一次原生标题',
      updated_at: '2026-08-20T01:00:00.000Z',
    }) + '\n', 'utf8')

    const first = []
    for await (const record of codexSourceDefinition.ingestHistory!(source)) first.push(record)
    assert.equal(first.filter(record => record.nativeType === 'metadata/session_title').length, 1)

    const unchanged = []
    for await (const record of codexSourceDefinition.ingestHistory!(source)) unchanged.push(record)
    assert.equal(unchanged.length, 0)

    await writeFile(indexPath, JSON.stringify({
      id: 'codex-test-1',
      thread_name: '第二次原生标题',
      updated_at: '2026-08-20T02:00:00.000Z',
    }) + '\n', 'utf8')

    const changed = []
    for await (const record of codexSourceDefinition.ingestHistory!(source)) changed.push(record)
    assert.equal(changed.length, 1)
    assert.equal(changed[0]?.nativeType, 'metadata/session_title')
    assert.equal((changed[0]?.payload as any).entry.payload.title, '第二次原生标题')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('normalizer uses event_msg.user_message as the only authoritative user request', async () => {
  const { root, sessions } = await withFixture()
  const source = sourceContext(root, sessions)

  try {
    const records = []
    for await (const record of codexSourceDefinition.ingestHistory!(source)) records.push(record)

    const outputs = []
    for (const record of records) {
      const normalized = await codexSourceDefinition.normalize(record, {
        host,
        installation: source.installation,
      })
      outputs.push(...normalized.observations)
      assert.equal(normalized.evidenceCandidates[0]?.sourceRecordId, record.id)
    }
    const kinds = outputs.map(item => item.kind)

    assert.deepEqual(kinds, [
      'session.lifecycle',
      'session.lifecycle',
      'session.lifecycle',
      'message.user',
      'message.reasoning',
      'message.assistant',
      'tool.call',
      'tool.result',
      'context.injected',
      'context.injected',
    ])

    assert.equal((outputs[3]?.payload as any).provenance.actualAuthor, 'human-user')
    assert.equal((outputs[3]?.payload as any).text, '运行测试并修复')
    assert.deepEqual(outputs[6]?.payload, {
      callId: 'call_c1',
      nativeToolName: 'shell_command',
      input: { command: 'npm test' },
    })
    assert.deepEqual(outputs[7]?.payload, {
      callId: 'call_c1',
      success: false,
      exitCode: 1,
      output: 'failed 1 test',
    })
    assert.equal((outputs[2]?.payload as any).event, 'turn.started')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('normalizer maps current Codex custom tool calls and structured outputs', async () => {
  const base: Omit<SourceRecord, 'id' | 'nativeType' | 'nativeId' | 'payload'> = {
    sourceId: 'codex',
    installationId: 'codex-install-1',
    sourceSessionNativeId: 'codex-custom-tools',
    capturedAt: '2026-08-31T12:00:00.000Z',
    locator: { kind: 'file', path: 'C:\\Users\\test\\.codex\\sessions\\rollout.jsonl' },
    fingerprint: 'custom-tools-fingerprint',
    parserVersion: '4',
  }
  const session = { nativeSessionId: 'codex-custom-tools', cwd: 'F:\\proj' }
  const call = await codexSourceDefinition.normalize({
    ...base,
    id: 'codex-custom-call',
    nativeType: 'response_item/custom_tool_call',
    nativeId: 'call_custom_1',
    payload: {
      entry: {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          input: '{"cmd":"npm run test:unit"}',
          call_id: 'call_custom_1',
          status: 'completed',
        },
      },
      session,
    },
  }, { host, installation: installation('C:\\codex', 'C:\\codex\\sessions') })
  const result = await codexSourceDefinition.normalize({
    ...base,
    id: 'codex-custom-result',
    nativeType: 'response_item/custom_tool_call_output',
    nativeId: 'call_custom_1',
    payload: {
      entry: {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call_custom_1',
          output: [{ type: 'text', text: 'Exit code: 0\nWall time: 0.4 seconds\nOutput:\n12 tests passed' }],
        },
      },
      session,
    },
  }, { host, installation: installation('C:\\codex', 'C:\\codex\\sessions') })

  assert.deepEqual(call.observations[0]?.payload, {
    callId: 'call_custom_1',
    nativeToolName: 'exec',
    input: { cmd: 'npm run test:unit' },
  })
  assert.deepEqual(result.observations[0]?.payload, {
    callId: 'call_custom_1',
    success: true,
    exitCode: 0,
    output: '12 tests passed',
  })
})
