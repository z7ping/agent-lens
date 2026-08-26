import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SourceExecutionContext, SourceRecord } from '@agent-lens/core'
import {
  discoverDshAssets,
  ingestDshHistory,
  normalizeDshRecord,
  parseDshJsonl,
} from './dsh'

function sourceContext(root: string): SourceExecutionContext {
  const values = new Map<string, unknown>()
  return {
    host: {
      id: 'host-test',
      name: 'test',
      platform: process.platform,
      arch: process.arch,
      createdAt: '2026-08-25T00:00:00.000Z',
      lastSeenAt: '2026-08-25T00:00:00.000Z',
    },
    installation: {
      id: 'installation-dsh-test',
      hostId: 'host-test',
      productId: 'dsh',
      configRoot: root,
      dataRoot: root,
      firstSeenAt: '2026-08-25T00:00:00.000Z',
      lastSeenAt: '2026-08-25T00:00:00.000Z',
    },
    abortSignal: new AbortController().signal,
    checkpoint: {
      async get<T>(key: string) { return (values.get(key) as T | undefined) ?? null },
      async set<T>(key: string, value: T) { values.set(key, value) },
      async clear(key: string) { values.delete(key) },
    },
  }
}

test('DSH JSONL 解析保留会话血统并跳过压缩 chunk 行', () => {
  const parsed = parseDshJsonl([
    JSON.stringify({ sessionId: 'child', cwd: '/repo/demo', parentSessionId: 'parent', parentEventSeq: 8 }),
    JSON.stringify({ seq: 1, type: 'turn/start', time: 1, data: {} }),
    JSON.stringify({ tag: 'text-chunks', chunks: ['ignored'] }),
    JSON.stringify({ seq: 2, type: 'user/message', time: 2, data: { content: '你好' } }),
  ].join('\n'))

  assert.ok(parsed)
  assert.equal(parsed.header.parentSessionId, 'parent')
  assert.equal(parsed.header.parentEventSeq, 8)
  assert.equal(parsed.events.length, 2)
})

test('DSH 归一化把父会话和工作区写入身份提示', async () => {
  const record: SourceRecord = {
    id: 'dsh-child-1',
    sourceId: 'dsh',
    installationId: 'installation-dsh-test',
    sourceSessionNativeId: 'child',
    nativeType: 'user/message',
    nativeId: 'child:1',
    sourceSequence: 10,
    occurredAt: '2026-08-25T00:00:01.000Z',
    capturedAt: '2026-08-25T00:00:02.000Z',
    locator: { kind: 'file', path: '/tmp/child.jsonl', offset: 1 },
    payload: {
      event: { seq: 1, type: 'user/message', data: { content: '继续' } },
      session: {
        nativeSessionId: 'child',
        profile: 'web',
        cwd: '/repo/demo',
        parentSessionId: 'parent',
        parentEventSeq: 8,
      },
      captureChannel: 'history',
    },
    parserVersion: '2',
  }

  const output = await normalizeDshRecord(record, {} as never)
  assert.equal(output.observations.length, 1)
  assert.deepEqual(output.observations[0]?.identityHints, {
    nativeSessionId: 'child',
    nativeParentSessionId: 'parent',
    workspacePath: '/repo/demo',
  })
})

test('DSH 历史检查点跳过未变化文件，并在追加事件后继续增量读取', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-dsh-history-'))
  const sessions = join(root, 'sessions')
  const path = join(sessions, 'session.jsonl')
  const context = sourceContext(root)
  const drain = async () => {
    const records: SourceRecord[] = []
    for await (const record of ingestDshHistory(context)) records.push(record)
    return records
  }

  try {
    await mkdir(sessions, { recursive: true })
    const header = JSON.stringify({ sessionId: 'session-1', cwd: '/repo/demo' })
    const first = JSON.stringify({ seq: 1, type: 'user/message', time: 1, data: { content: '一' } })
    await writeFile(path, `${header}\n${first}\n`)

    assert.equal((await drain()).length, 1)
    assert.equal((await drain()).length, 0)

    const second = JSON.stringify({ seq: 2, type: 'assistant/message', time: 2, data: { content: '二' } })
    await writeFile(path, `${header}\n${first}\n${second}\n`)
    const appended = await drain()
    assert.equal(appended.length, 1)
    assert.equal(appended[0]?.nativeId, 'session-1:2')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('DSH Profile 静态发现区分 Bundle、树外插件和配置覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-dsh-'))
  try {
    await mkdir(join(root, 'node_modules', '@demo', 'plugin'), { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'demo-profile',
      dependencies: {
        '@deepseek-ai/dsh-base': '1.2.3',
        '@demo/plugin': '4.5.6',
      },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }))
    await writeFile(join(root, 'cordis.patch.yml'), '- name: demo\n')

    const assets = []
    for await (const asset of discoverDshAssets(sourceContext(root))) assets.push(asset)

    const bundle = assets.find(item => item.binding?.source === 'dsh:bundle')
    const plugin = assets.find(item => item.binding?.source === 'dsh:profile-plugin')
    const config = assets.find(item => item.binding?.source === 'dsh:profile-config')

    assert.equal(bundle?.definition.canonicalName, '@deepseek-ai/dsh-base')
    assert.equal(bundle?.definition.type, 'plugin')
    assert.equal(plugin?.definition.canonicalName, '@demo/plugin')
    assert.equal(plugin?.binding?.version, '4.5.6')
    assert.equal(config?.definition.type, 'rule')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
