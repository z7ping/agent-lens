import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import {
  SourceHistoryRunner,
  SourceRuntimeRunner,
} from '@agent-lens/core-services/source-runner'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { codexSourceDefinition, detectCodex } from './index'

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`)
}

async function prepareFixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-codex-runtime-e2e-'))
  const sessions = join(root, 'sessions')
  const target = join(sessions, '2026', '07', '02', 'rollout-test.jsonl')
  const inbox = join(root, 'agent-lens-inbox')
  await mkdir(dirname(target), { recursive: true })
  await mkdir(inbox, { recursive: true })
  const fixture = await readFile(
    new URL('./__fixtures__/codex-sample.jsonl', import.meta.url),
    'utf8',
  )
  await writeFile(target, fixture, 'utf8')
  return { root, sessions, inbox }
}

test('Codex runtime hook merges with history observation and adds runtime evidence', async () => {
  const fixture = await prepareFixture()
  const previousInbox = process.env.AGENT_LENS_CODEX_INBOX
  process.env.AGENT_LENS_CODEX_INBOX = fixture.inbox
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  const controller = new AbortController()

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
    )
    const runtime = new SourceRuntimeRunner(
      storage,
      identity,
      observations,
      capabilities,
      coverage,
    )
    const host = await identity.resolveHost({
      name: 'codex-runtime-e2e-host',
      platform: process.platform,
      arch: process.arch,
    })
    const [detected] = await detectCodex({
      host,
      env: { CODEX_HOME: fixture.root, PATH: '' },
    })
    assert.ok(detected)

    const historyResult = await history.sync({
      source: codexSourceDefinition,
      host,
      detected,
      abortSignal: controller.signal,
    })

    let toolCalls = await storage.repositories.observations.query({
      installationId: historyResult.installationId,
      kind: 'tool.call',
      limit: 20,
    })
    assert.equal(toolCalls.length, 1)
    assert.equal(toolCalls[0]?.evidenceRefs.length, 1)

    const handle = await runtime.start({
      source: codexSourceDefinition,
      host,
      detected,
      abortSignal: controller.signal,
    })

    try {
      const capturedAt = new Date().toISOString()
      await writeFile(
        join(fixture.inbox, 'runtime-call-c1.json'),
        JSON.stringify({
          id: 'runtime-pretool-call-c1',
          capturedAt,
          event: {
            hook_event_name: 'PreToolUse',
            session_id: 'codex-test-1',
            call_id: 'call_c1',
            cwd: 'F:\\proj',
            tool_name: 'shell_command',
            tool_input: { command: 'npm test' },
            timestamp: capturedAt,
          },
        }),
        'utf8',
      )

      await waitFor(async () => {
        const rows = await storage.repositories.observations.query({
          installationId: historyResult.installationId,
          kind: 'tool.call',
          limit: 20,
        })
        return rows.length === 1 && rows[0]!.evidenceRefs.length === 2
      })

      toolCalls = await storage.repositories.observations.query({
        installationId: historyResult.installationId,
        kind: 'tool.call',
        limit: 20,
      })
      assert.equal(toolCalls.length, 1)
      assert.equal(toolCalls[0]?.evidenceRefs.length, 2)

      const evidences = await Promise.all(
        toolCalls[0]!.evidenceRefs.map(id => storage.repositories.evidence.get(id)),
      )
      assert.deepEqual(
        new Set(evidences.map(item => item?.captureMethod)),
        new Set(['native-log', 'runtime-hook']),
      )

      const sourceRecordCount = storage.db.prepare(
        'SELECT COUNT(*) AS count FROM source_records',
      ).get() as { count: number }
      assert.equal(sourceRecordCount.count, 9)
    } finally {
      controller.abort()
      await handle.dispose()
    }
  } finally {
    storage.close()
    if (previousInbox === undefined) delete process.env.AGENT_LENS_CODEX_INBOX
    else process.env.AGENT_LENS_CODEX_INBOX = previousInbox
    await rm(fixture.root, { recursive: true, force: true })
  }
})
