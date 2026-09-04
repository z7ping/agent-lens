import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  AgentInstallation,
  DetectedSource,
  Host,
  SourceDefinition,
} from '@agent-lens/core'
import type { AgentLensContext } from './context'
import {
  prepareRegisteredSources,
  syncRegisteredSourceHistory,
  type RegisteredSourceTarget,
} from './source-sync'

const host: Host = {
  id: 'host',
  name: 'test-host',
  platform: 'win32',
  arch: 'x64',
  createdAt: '2026-08-21T00:00:00.000Z',
  lastSeenAt: '2026-08-21T00:00:00.000Z',
}

const installation: AgentInstallation = {
  id: 'installation',
  hostId: host.id,
  productId: 'test-product',
  firstSeenAt: '2026-08-21T00:00:00.000Z',
  lastSeenAt: '2026-08-21T00:00:00.000Z',
}

function sourceDefinition(
  sourceId: string,
  detect: SourceDefinition['detect'],
): SourceDefinition {
  return {
    manifest: {
      sourceId,
      productId: 'test-product',
      pluginId: `test:${sourceId}`,
      pluginVersion: '1.0.0',
      apiVersion: '1.0',
      pluginType: 'source',
      displayName: sourceId,
      parserVersion: '1',
    },
    detect,
    async declareCapabilities() { return [] },
    async normalize() { return { observations: [], evidenceCandidates: [] } },
  }
}

function capturePolicy(enabledSources: string[]) {
  const enabled = new Set(enabledSources)
  return {
    isSourceEnabled(sourceId: string) { return enabled.has(sourceId) },
  }
}

test('prepareRegisteredSources detects each enabled source once and isolates detection failures', async () => {
  let goodDetections = 0
  let badDetections = 0
  const good = sourceDefinition('good', async () => {
    goodDetections += 1
    return [{ sourceId: 'good', productId: 'test-product', confidence: 'exact' }]
  })
  const bad = sourceDefinition('bad', async () => {
    badDetections += 1
    throw new Error('broken detection')
  })
  const emitted: unknown[][] = []
  const ctx = {
    sources: { list: () => [good, bad] },
    capturePolicy: capturePolicy(['good', 'bad']),
    identity: {
      async resolveHost() { return host },
      async resolveInstallation() { return installation },
    },
    emit(...args: unknown[]) { emitted.push(args) },
  } as unknown as AgentLensContext

  const prepared = await prepareRegisteredSources(ctx, new AbortController().signal)

  assert.equal(goodDetections, 1)
  assert.equal(badDetections, 1)
  assert.equal(prepared.targets.length, 1)
  assert.equal(prepared.targets[0]?.source.manifest.sourceId, 'good')
  assert.equal(prepared.failures.length, 1)
  assert.equal(prepared.failures[0]?.sourceId, 'bad')
  assert.equal(prepared.failures[0]?.stage, 'detect')
  assert.equal(emitted.length, 1)
})

test('disabled sources are filtered before detect', async () => {
  let detections = 0
  const disabled = sourceDefinition('disabled', async () => {
    detections += 1
    return [{ sourceId: 'disabled', productId: 'test-product', confidence: 'exact' }]
  })
  const ctx = {
    sources: { list: () => [disabled] },
    capturePolicy: capturePolicy([]),
    identity: {
      async resolveHost() { return host },
      async resolveInstallation() { return installation },
    },
    emit() {},
  } as unknown as AgentLensContext

  const prepared = await prepareRegisteredSources(ctx, new AbortController().signal)

  assert.equal(detections, 0)
  assert.deepEqual(prepared.targets, [])
  assert.deepEqual(prepared.failures, [])
})

test('history synchronization continues after one source fails', async () => {
  const failing = sourceDefinition('failing', async () => [])
  let receivedActiveSince: string | undefined
  failing.ingestHistory = async function* (ctx) {
    receivedActiveSince = ctx.historyWindow?.activeSince
    throw new Error('broken history')
  }
  const healthy = sourceDefinition('healthy', async () => [])
  const detected = (sourceId: string): DetectedSource => ({
    sourceId,
    productId: 'test-product',
    confidence: 'exact',
  })
  const targets: RegisteredSourceTarget[] = [
    { source: failing, host, detected: detected('failing') },
    { source: healthy, host, detected: detected('healthy') },
  ]
  const ctx = {
    storage: {
      repositories: {
        sourceRecords: {
          async listForParserReplay() { return [] },
        },
      },
    },
    identity: { async resolveInstallation() { return installation } },
    observations: {},
    capabilities: {
      registerSourceCapabilities() { return { dispose() {} } },
    },
    coverage: {},
    capturePolicy: capturePolicy(['failing', 'healthy']),
  } as unknown as AgentLensContext

  const settled = await syncRegisteredSourceHistory(
    ctx,
    new AbortController().signal,
    targets,
    { activeSince: '2026-08-25T00:00:00.000Z' },
  )

  assert.equal(receivedActiveSince, '2026-08-25T00:00:00.000Z')
  assert.equal(settled.failures.length, 1)
  assert.equal(settled.failures[0]?.sourceId, 'failing')
  assert.equal(settled.results.length, 1)
  assert.equal(settled.results[0]?.sourceId, 'healthy')
})

test('disabled prepared targets are ignored by later stages', async () => {
  let historyReads = 0
  const disabled = sourceDefinition('disabled', async () => [])
  disabled.ingestHistory = async function* () {
    historyReads += 1
  }
  const targets: RegisteredSourceTarget[] = [{
    source: disabled,
    host,
    detected: { sourceId: 'disabled', productId: 'test-product', confidence: 'exact' },
  }]
  const ctx = {
    storage: {},
    identity: { async resolveInstallation() { return installation } },
    observations: {},
    capabilities: { registerSourceCapabilities() { return { dispose() {} } } },
    coverage: {},
    capturePolicy: capturePolicy([]),
  } as unknown as AgentLensContext

  const settled = await syncRegisteredSourceHistory(ctx, new AbortController().signal, targets)

  assert.equal(historyReads, 0)
  assert.deepEqual(settled.results, [])
  assert.deepEqual(settled.failures, [])
})
