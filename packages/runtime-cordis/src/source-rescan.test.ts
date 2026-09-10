import assert from 'node:assert/strict'
import test from 'node:test'
import type { Host, SourceDefinition } from '@agent-lens/core'
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

test('并发重新扫描复用同一次运行，不重复执行 Source detection', async () => {
  let detections = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const definition = source(async () => {
    detections += 1
    await gate
    return []
  })
  const ctx = {
    sources: { list: () => [definition] },
    capturePolicy: {
      isSourceEnabled: () => true,
    },
    identity: {
      async resolveHost() { return host },
    },
  } as unknown as AgentLensContext
  const service = new SourceRescanService(ctx, new AbortController().signal)

  const first = service.rescan()
  const second = service.rescan()
  assert.equal(first, second)

  release()
  const result = await first
  assert.equal(detections, 1)
  assert.equal(result.status, 'completed')
  assert.equal(result.sourcesDetected, 0)
  assert.equal(result.assetSourcesScanned, 0)
})
