import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  DefaultCapabilityService,
  DefaultCoverageService,
  DefaultEvidenceService,
  DefaultIdentityService,
  DefaultObservationService,
} from '@agent-lens/core-services'
import { SourceHistoryRunner } from '@agent-lens/core-services/source-runner'
import { createTestCapturePolicy } from '@agent-lens/core-services/test-support'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { detectPi, discoverPiAssets, piSourceDefinition } from './index'

function sessionLine(id = 'pi-integrity-session') {
  return JSON.stringify({
    type: 'session',
    id,
    version: 3,
    cwd: '/workspace/pi-integrity',
    timestamp: '2026-09-10T00:00:00.000Z',
  })
}

async function withHistoryRunner<T>(
  agentDir: string,
  run: (input: {
    storage: SqliteStorageService
    history: SourceHistoryRunner
    host: Awaited<ReturnType<DefaultIdentityService['resolveHost']>>
    detected: NonNullable<Awaited<ReturnType<typeof detectPi>>[number]>
  }) => Promise<T>,
): Promise<T> {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const evidence = new DefaultEvidenceService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const capabilities = new DefaultCapabilityService()
    const coverage = new DefaultCoverageService(storage, evidence)
    const history = new SourceHistoryRunner(
      storage,
      identity,
      observations,
      capabilities,
      coverage,
      createTestCapturePolicy(['pi']),
    )
    const host = await identity.resolveHost({ name: 'pi-integrity-host' })
    const [detected] = await detectPi({ host, env: { PI_CODING_AGENT_DIR: agentDir, PATH: '' } })
    assert.ok(detected)
    return await run({ storage, history, host, detected })
  } finally {
    storage.close()
  }
}

test('Pi history does not consume an unterminated partial JSONL entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-partial-'))
  const agentDir = join(root, 'agent')
  const transcript = join(agentDir, 'sessions', 'partial', 'session.jsonl')
  await mkdir(dirname(transcript), { recursive: true })

  const partial = '{"type":"message","id":"pi-user-partial","timestamp":"2026-09-10T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"hel'
  await writeFile(transcript, `${sessionLine()}\n${partial}`, 'utf8')

  try {
    await withHistoryRunner(agentDir, async ({ storage, history, host, detected }) => {
      const first = await history.sync({
        source: piSourceDefinition,
        host,
        detected,
        abortSignal: new AbortController().signal,
      })
      assert.equal(first.records, 1)
      assert.equal((await storage.repositories.observations.query({ kind: 'message.user', limit: 20 })).length, 0)

      await appendFile(transcript, 'lo"}]}}\n', 'utf8')

      const second = await history.sync({
        source: piSourceDefinition,
        host,
        detected,
        abortSignal: new AbortController().signal,
      })
      assert.equal(second.records, 1)
      const users = await storage.repositories.observations.query({ kind: 'message.user', limit: 20 })
      assert.equal(users.length, 1)
      assert.equal(users[0]?.nativeEventId, 'pi-user-partial')
      assert.equal((users[0]?.payload as { text?: string }).text, 'hello')
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Pi history preserves a newline-terminated malformed row and continues afterwards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-malformed-'))
  const agentDir = join(root, 'agent')
  const transcript = join(agentDir, 'sessions', 'malformed', 'session.jsonl')
  await mkdir(dirname(transcript), { recursive: true })
  await writeFile(transcript, [
    sessionLine('pi-malformed-session'),
    '{not-json}',
    JSON.stringify({
      type: 'message',
      id: 'pi-user-after-malformed',
      timestamp: '2026-09-10T00:00:02.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'after malformed' }] },
    }),
    '',
  ].join('\n'), 'utf8')

  try {
    await withHistoryRunner(agentDir, async ({ storage, history, host, detected }) => {
      const result = await history.sync({
        source: piSourceDefinition,
        host,
        detected,
        abortSignal: new AbortController().signal,
      })
      assert.equal(result.records, 3)
      const unknown = await storage.repositories.observations.query({ kind: 'unknown', limit: 20 })
      assert.ok(unknown.some(item => {
        const payload = item.payload as { rawType?: string; rawPayload?: { raw?: string } }
        return payload.rawType === 'malformed-json' && payload.rawPayload?.raw === '{not-json}'
      }))
      const users = await storage.repositories.observations.query({ kind: 'message.user', limit: 20 })
      assert.ok(users.some(item => item.nativeEventId === 'pi-user-after-malformed'))
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Pi detection honors absolute settings.sessionDir without overriding an explicit environment session dir', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-session-dir-'))
  const agentDir = join(root, 'agent')
  const settingsSessions = join(root, 'settings-sessions')
  const envSessions = join(root, 'env-sessions')
  await mkdir(agentDir, { recursive: true })
  await mkdir(settingsSessions, { recursive: true })
  await mkdir(envSessions, { recursive: true })
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ sessionDir: settingsSessions }), 'utf8')

  const host = {
    id: 'pi-session-dir-host',
    name: 'pi-session-dir-host',
    platform: process.platform,
    arch: process.arch,
    createdAt: '2026-09-10T00:00:00.000Z',
    lastSeenAt: '2026-09-10T00:00:00.000Z',
  }

  try {
    const [fromSettings] = await detectPi({ host, env: { PI_CODING_AGENT_DIR: agentDir, PATH: '' } })
    assert.equal(fromSettings?.dataRoot, settingsSessions)

    const [fromEnv] = await detectPi({
      host,
      env: {
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_SESSION_DIR: envSessions,
        PATH: '',
      },
    })
    assert.equal(fromEnv?.dataRoot, envSessions)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Pi detection does not resolve relative session roots against the AgentLens daemon cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-relative-session-dir-'))
  const agentDir = join(root, 'agent')
  await mkdir(agentDir, { recursive: true })

  const host = {
    id: 'pi-relative-session-dir-host',
    name: 'pi-relative-session-dir-host',
    platform: process.platform,
    arch: process.arch,
    createdAt: '2026-09-10T00:00:00.000Z',
    lastSeenAt: '2026-09-10T00:00:00.000Z',
  }

  try {
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ sessionDir: './sessions-from-invocation' }), 'utf8')
    const [fromSettings] = await detectPi({ host, env: { PI_CODING_AGENT_DIR: agentDir, PATH: '' } })
    assert.ok(fromSettings)
    assert.equal(fromSettings.dataRoot, undefined)

    const [fromEnv] = await detectPi({
      host,
      env: {
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_SESSION_DIR: './sessions-from-env-invocation',
        PATH: '',
      },
    })
    assert.ok(fromEnv)
    assert.equal(fromEnv.dataRoot, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Pi detection does not claim a relative agent root without invocation cwd evidence', async () => {
  const host = {
    id: 'pi-relative-agent-dir-host',
    name: 'pi-relative-agent-dir-host',
    platform: process.platform,
    arch: process.arch,
    createdAt: '2026-09-10T00:00:00.000Z',
    lastSeenAt: '2026-09-10T00:00:00.000Z',
  }

  const detected = await detectPi({
    host,
    env: {
      PI_CODING_AGENT_DIR: './relative-agent-dir',
      PATH: '',
    },
  })
  assert.deepEqual(detected, [])
})

test('Pi asset discovery does not promote extension-private settings or arbitrary files into native assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-assets-'))
  const agentDir = join(root, 'agent')
  const sessions = join(agentDir, 'sessions')
  const skillDir = join(agentDir, 'skills', 'reviewer')
  const extensions = join(agentDir, 'extensions')
  await mkdir(skillDir, { recursive: true })
  await mkdir(join(extensions, 'empty-directory'), { recursive: true })
  await mkdir(sessions, { recursive: true })
  await mkdir(join(agentDir, 'pi-hermes-memory'), { recursive: true })
  await mkdir(join(agentDir, 'projects-memory'), { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), [
    '---',
    'name: reviewer',
    'description: Review changes.',
    '---',
    '',
  ].join('\n'), 'utf8')
  await writeFile(join(extensions, 'trace.ts'), 'export default function trace() {}\n', 'utf8')
  await writeFile(join(extensions, 'README.md'), '# not an extension\n', 'utf8')
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    mcpServers: { privateExtensionServer: { command: 'node' } },
  }), 'utf8')

  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const host = await identity.resolveHost({ name: 'pi-assets-host' })
    const installation = await identity.resolveInstallation({
      hostId: host.id,
      productId: 'pi',
      configRoot: agentDir,
      dataRoot: sessions,
    })
    const context = {
      host,
      installation,
      abortSignal: new AbortController().signal,
      checkpoint: {
        async get<T>(_key: string): Promise<T | null> { return null },
        async set<T>(_key: string, _value: T): Promise<void> {},
        async clear(_key: string): Promise<void> {},
      },
    }

    const assets = []
    for await (const asset of discoverPiAssets(context)) assets.push(asset)
    assert.deepEqual(assets.map(asset => asset.definition.canonicalName).sort(), ['reviewer', 'trace'])
    for (const asset of assets) {
      assert.equal(asset.states?.find(state => state.state === 'installed')?.value, true)
      assert.equal(asset.states?.find(state => state.state === 'discoverable')?.value, 'unknown')
      assert.equal(asset.states?.find(state => state.state === 'enabled'), undefined)
    }
  } finally {
    storage.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('Pi session SourceRecord nativeId is the upstream session id without AgentLens prefix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-native-source-id-'))
  const agentDir = join(root, 'agent')
  const transcript = join(agentDir, 'sessions', 'native-id', 'session.jsonl')
  await mkdir(dirname(transcript), { recursive: true })
  await writeFile(transcript, `${sessionLine('pi-upstream-session-id')}\n`, 'utf8')

  try {
    await withHistoryRunner(agentDir, async ({ storage, history, host, detected }) => {
      await history.sync({
        source: piSourceDefinition,
        host,
        detected,
        abortSignal: new AbortController().signal,
      })

      const row = storage.db.prepare(`
        SELECT native_id AS nativeId
        FROM source_records
        WHERE source_id = 'pi' AND native_type = 'history/session'
        LIMIT 1
      `).get() as { nativeId: string | null } | undefined

      assert.equal(row?.nativeId, 'pi-upstream-session-id')
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

