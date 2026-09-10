import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentInstallation, Host, SourceDefinition } from '@agent-lens/core'
import type { AgentLensContext } from './context'
import { SourceRescanService } from './source-rescan'

const host: Host = {
  id: 'host-rescan',
  name: 'test-host',
  platform: 'win32',
  arch: 'x64',
  createdAt: '2026-09-10T00:00:00.000Z',
  lastSeenAt: '2026-09-10T00:00:00.000Z',
}

const installation: AgentInstallation = {
  id: 'installation-rescan',
  hostId: host.id,
  productId: 'test-product',
  firstSeenAt: '2026-09-10T00:00:00.000Z',
  lastSeenAt: '2026-09-10T00:00:00.000Z',
}

function source(detect: SourceDefinition['detect']): SourceDefinition {
  return {
    manifest: {
      pluginId: 'test-source-plugin',
      pluginVersion: '1.0.0',
      apiVersion: '1.0',
      pluginType: 'source',
      displayName: 'Test Source',
      sourceId: 'test-source',
      productId: 'test-product',
      parserVersion: '1',
    },
    detect,
    async declareCapabilities() { return [] },
    async normalize() { return { observations: [], evidenceCandidates: [] } },
  }
}

function context(definition: SourceDefinition): AgentLensContext {
  return {
    sources: { list: () => [definition] },
    capturePolicy: {
      isSourceEnabled: () => true,
    },
    identity: {
      async resolveHost() { return host },
      async resolveInstallation() { return installation },
    },
  } as unknown as AgentLensContext
}

test('并发重新扫描复用同一次运行，不重复执行 Source detection', async () => {
  let detections = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const definition = source(async () => {
    detections += 1
    await gate
    return []
  })
  const service = new SourceRescanService(context(definition), new AbortController().signal)

  const first = service.rescan()
  const second = service.rescan()
  assert.equal(first, second)

  release()
  const result = await first
  assert.equal(detections, 1)
  assert.equal(result.status, 'completed')
  assert.equal(result.sourcesDetected, 0)
  assert.equal(result.assetSourcesScanned, 0)
  assert.equal(service.isSourceDetected('test-source'), false)
})

test('重新扫描维护当前检测状态，检测失败不会把已检测来源误判为卸载', async () => {
  let mode: 'detected' | 'missing' | 'failed' = 'missing'
  const definition = source(async () => {
    if (mode === 'failed') throw new Error('detector unavailable')
    if (mode === 'missing') return []
    return [{ sourceId: 'test-source', productId: 'test-product', confidence: 'exact' }]
  })
  const service = new SourceRescanService(context(definition), new AbortController().signal)

  await service.rescan()
  assert.equal(service.isSourceDetected('test-source'), false)

  mode = 'detected'
  await service.rescan()
  assert.equal(service.isSourceDetected('test-source'), true)

  mode = 'failed'
  const failed = await service.rescan()
  assert.equal(failed.status, 'failed')
  assert.equal(service.isSourceDetected('test-source'), true)
})
