import test from 'node:test'
import assert from 'node:assert/strict'
import type { SourceDefinition, SourceDetectionContext } from '@agent-lens/core'
import { DefaultSourceService } from './index'

function stubSource(): SourceDefinition {
  return {
    manifest: {
      pluginId: 'mock-source',
      pluginVersion: '1.0.0',
      apiVersion: '1.0',
      pluginType: 'source',
      displayName: 'Mock Source',
      sourceId: 'mock-source',
      productId: 'mock',
      parserVersion: '1',
    },
    async detect() { return [] },
    async declareCapabilities() { return [] },
    async normalize() { return { observations: [], evidenceCandidates: [] } },
  }
}

test('Source registration accepts valid third-party definitions and disposes cleanly', () => {
  const registry = new DefaultSourceService()
  const source = stubSource()
  const registration = registry.register(source)
  assert.deepEqual(registry.list(), [source])
  registration.dispose()
  assert.deepEqual(registry.list(), [])
})

test('Source registration rejects incompatible manifests before advertising them', () => {
  for (const invalid of [
    { apiVersion: '99.0' },
    { pluginType: 'live' },
    { pluginId: '' },
    { sourceId: '' },
    { productId: '' },
    { parserVersion: '' },
  ]) {
    const source = stubSource()
    Object.assign(source.manifest, invalid)
    assert.throws(() => new DefaultSourceService().register(source), /source manifest invalid/)
  }
})

test('Source registration checks all required runtime methods and duplicate ids', () => {
  for (const method of ['detect', 'declareCapabilities', 'normalize'] as const) {
    const source = stubSource()
    Object.assign(source, { [method]: undefined })
    assert.throws(() => new DefaultSourceService().register(source), new RegExp(`missing required ${method}`))
  }
  const registry = new DefaultSourceService()
  registry.register(stubSource())
  assert.throws(() => registry.register(stubSource()), /already registered/)
})

test('Source discovery must not impersonate another registered Source or Agent product', async () => {
  for (const identity of [
    { sourceId: 'other-source', productId: 'mock' },
    { sourceId: 'mock-source', productId: 'other-product' },
  ]) {
    const registry = new DefaultSourceService()
    const source = stubSource()
    source.detect = async () => [{ ...identity, confidence: 'exact' }]
    registry.register(source)
    await assert.rejects(registry.detect({} as SourceDetectionContext), /detection identity mismatch/)
  }
  const registry = new DefaultSourceService()
  const valid = stubSource()
  valid.detect = async () => [{ sourceId: 'mock-source', productId: 'mock', confidence: 'exact' }]
  registry.register(valid)
  assert.equal((await registry.detect({} as SourceDetectionContext)).length, 1)
})
