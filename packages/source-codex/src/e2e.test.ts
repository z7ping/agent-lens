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
import { SourceHistoryRunner } from '@agent-lens/core-services/source-runner'
import { createTestCapturePolicy } from '@agent-lens/core-services/test-support'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import {
  codexSourceDefinition,
  detectCodex,
} from './index'

async function prepareFixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-codex-e2e-'))
  const sessions = join(root, 'sessions')
  const target = join(sessions, '2026', '07', '02', 'rollout-test.jsonl')
  await mkdir(dirname(target), { recursive: true })
  const fixture = await readFile(
    new URL('./__fixtures__/codex-sample.jsonl', import.meta.url),
    'utf8',
  )
  await writeFile(target, fixture, 'utf8')
  return { root, sessions }
}

test('Codex fixture enters canonical facts and remains idempotent', async () => {
  const fixture = await prepareFixture()
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()

  try {
    const identity = new DefaultIdentityService(storage)
    const evidence = new DefaultEvidenceService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const capabilities = new DefaultCapabilityService()
    const coverage = new DefaultCoverageService(storage, evidence)
    const capturePolicy = createTestCapturePolicy(['codex'])
    const runner = new SourceHistoryRunner(
      storage,
      identity,
      observations,
      capabilities,
      coverage,
      capturePolicy,
    )
    const host = await identity.resolveHost({
      name: 'codex-e2e-host',
      platform: process.platform,
      arch: process.arch,
    })
    const [detected] = await detectCodex({
      host,
      env: { CODEX_HOME: fixture.root, PATH: '' },
    })
    assert.ok(detected)
    assert.equal(detected.dataRoot, fixture.sessions)

    const first = await runner.sync({
      source: codexSourceDefinition,
      host,
      detected,
      abortSignal: new AbortController().signal,
    })

    // 10 条原生 rollout 记录 + 1 条稳定的 session_start 元数据。
    // 纯 response_item role=user 传输回显保留 Evidence，但不生成 Canonical Observation。
    assert.equal(first.records, 11)
    assert.equal(first.observationsCreated, 10)
    assert.equal(first.observationsMerged, 0)
    assert.equal(first.observationsUnchanged, 0)

    const facts = await storage.repositories.observations.query({
      installationId: first.installationId,
      limit: 100,
    })
    assert.equal(facts.length, 10)
    // Developer + runtime environment 仍是结构化 context；纯用户传输回显不进入活动流。
    assert.equal(facts.filter(item => item.kind === 'context.injected').length, 2)
    assert.equal(facts.filter(item => item.kind === 'unknown').length, 0)
    assert.equal(facts.filter(item => item.kind === 'message.reasoning').length, 1)
    assert.equal(facts.filter(item => item.kind === 'tool.call').length, 1)
    assert.equal(facts.filter(item => item.kind === 'tool.result').length, 1)
    assert.equal(facts.every(item => item.evidenceRefs.length >= 1), true)

    const reasoning = facts.find(item => item.kind === 'message.reasoning')
    assert.equal((reasoning?.payload as { text?: string } | undefined)?.text, '先确认失败测试，再检查相关实现。')

    const evidenceCount = storage.db.prepare(
      'SELECT COUNT(*) AS count FROM evidence',
    ).get() as { count: number }
    assert.equal(evidenceCount.count, 11)

    const toolCoverage = await storage.repositories.coverage.query({
      subjectType: 'AgentInstallation',
      subjectId: first.installationId,
      capability: 'tool-call',
    })
    assert.equal(toolCoverage.length, 1)
    assert.equal(toolCoverage[0]?.status, 'complete')
    assert.ok(toolCoverage[0]?.from)
    assert.ok(toolCoverage[0]?.to)

    const second = await runner.sync({
      source: codexSourceDefinition,
      host,
      detected,
      abortSignal: new AbortController().signal,
    })
    assert.equal(second.records, 0)
    assert.equal(second.observationsCreated, 0)

    const factsAfterReplay = await storage.repositories.observations.query({
      installationId: first.installationId,
      limit: 100,
    })
    assert.equal(factsAfterReplay.length, 10)
  } finally {
    storage.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
