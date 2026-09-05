import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  AgentInstallation,
  CapturePolicyService,
  DetectedSource,
  Host,
  NormalizedSourceOutput,
  SourceDefinition,
  SourceRecord,
} from '@agent-lens/core'
import { SourceHistoryRunner } from './source-runner'

const host: Host = {
  id: 'host-1',
  name: 'test-host',
  platform: 'linux',
  arch: 'x64',
  createdAt: '2026-09-05T00:00:00.000Z',
  lastSeenAt: '2026-09-05T00:00:00.000Z',
}

const installation: AgentInstallation = {
  id: 'installation-1',
  hostId: host.id,
  productId: 'test-product',
  firstSeenAt: '2026-09-05T00:00:00.000Z',
  lastSeenAt: '2026-09-05T00:00:00.000Z',
}

const detected: DetectedSource = {
  sourceId: 'test-source',
  productId: 'test-product',
  confidence: 'exact',
}

function record(id: string, capturedAt: string): SourceRecord {
  return {
    id,
    sourceId: 'test-source',
    installationId: installation.id,
    nativeType: 'message',
    nativeId: id,
    capturedAt,
    occurredAt: capturedAt,
    locator: { kind: 'file', path: `/tmp/${id}.jsonl` },
    payload: { id },
    parserVersion: '1',
  }
}

function output(): NormalizedSourceOutput {
  return { observations: [], evidenceCandidates: [] }
}

const capturePolicy = {
  sanitizeSourceRecord(value: SourceRecord) { return value },
  sanitizeNormalizedOutput(value: NormalizedSourceOutput) { return value },
} as unknown as CapturePolicyService

function createCheckpointStore() {
  const values = new Map<string, unknown>()
  return {
    values,
    repository: {
      async get<T>(scope: string, key: string): Promise<T | null> {
        return (values.get(`${scope}/${key}`) as T | undefined) ?? null
      },
      async set<T>(scope: string, key: string, value: T): Promise<void> {
        values.set(`${scope}/${key}`, structuredClone(value))
      },
      async clear(scope: string, key: string): Promise<void> {
        values.delete(`${scope}/${key}`)
      },
    },
  }
}

function createRunner(
  sourceRecords: Record<string, unknown>,
  checkpoints: ReturnType<typeof createCheckpointStore>['repository'],
) {
  return new SourceHistoryRunner(
    {
      repositories: { sourceRecords },
      checkpoints,
      async transaction(operation: () => Promise<unknown>) { return operation() },
    } as any,
    { async resolveInstallation() { return installation } } as any,
    { async commit() { throw new Error('No observations expected') } } as any,
    { registerSourceCapabilities() { return { dispose() {} } } } as any,
    { async declare() { return {} as any } } as any,
    capturePolicy,
  )
}

function source(normalize: SourceDefinition['normalize']): SourceDefinition {
  return {
    manifest: {
      pluginId: 'test-source-plugin',
      pluginVersion: '1.0.0',
      apiVersion: '1.0',
      pluginType: 'source',
      displayName: 'Test Source',
      sourceId: 'test-source',
      productId: 'test-product',
      parserVersion: '2',
    },
    async detect() { return [detected] },
    async declareCapabilities() { return [] },
    normalize,
  }
}

test('completed parser replay is skipped without reading source records again', async () => {
  const checkpoints = createCheckpointStore()
  let replayReads = 0
  const runner = createRunner({
    async put() {},
    async listForParserReplay() {
      replayReads += 1
      return []
    },
  }, checkpoints.repository)
  const definition = source(async () => output())

  await runner.replay({
    source: definition,
    host,
    detected,
    abortSignal: new AbortController().signal,
  })
  assert.equal(replayReads, 1)
  const completed = [...checkpoints.values.values()][0] as any
  assert.equal(completed.state, 'completed')
  assert.equal(completed.dirty, false)

  await runner.replay({
    source: definition,
    host,
    detected,
    abortSignal: new AbortController().signal,
  })
  assert.equal(replayReads, 1)
})

test('parser replay resumes from the last successfully processed record after cancellation', async () => {
  const checkpoints = createCheckpointStore()
  const first = record('a', '2026-09-01T00:00:00.000Z')
  const second = record('b', '2026-09-01T00:01:00.000Z')
  const processed: string[] = []
  let firstRun = true
  const firstController = new AbortController()

  const runner = createRunner({
    async put(value: SourceRecord) { processed.push(value.id) },
    async listForParserReplay(
      _sourceId: string,
      _installationId: string,
      _targetParserVersion: string,
      after?: { id: string },
    ) {
      if (!after) return [first, second]
      if (after.id === first.id) return [second]
      return []
    },
  }, checkpoints.repository)

  const definition = source(async value => {
    if (firstRun && value.id === first.id) firstController.abort()
    return output()
  })

  await runner.replay({
    source: definition,
    host,
    detected,
    abortSignal: firstController.signal,
  })
  assert.deepEqual(processed, ['a'])
  const interrupted = [...checkpoints.values.values()][0] as any
  assert.equal(interrupted.state, 'running')
  assert.equal(interrupted.cursor.id, 'a')

  firstRun = false
  await runner.replay({
    source: definition,
    host,
    detected,
    abortSignal: new AbortController().signal,
  })
  assert.deepEqual(processed, ['a', 'b'])
  const completed = [...checkpoints.values.values()][0] as any
  assert.equal(completed.state, 'completed')
  assert.equal(completed.cursor.id, 'b')
})
