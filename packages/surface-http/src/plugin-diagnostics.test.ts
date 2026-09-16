import assert from 'node:assert/strict'
import test from 'node:test'
import type { StorageService } from '@agent-lens/core'
import { httpSurfacePluginInternals } from './plugin'

test('deep diagnostics contribution 只合入 diagnostics，不污染 health', async () => {
  let contributionCalls = 0
  const storage = {
    async health() {
      return { ok: true, details: { base: 'health' } }
    },
    async diagnostics() {
      return { ok: true, details: { base: 'diagnostics' } }
    },
  } as unknown as StorageService

  const wrapped = httpSurfacePluginInternals.storageWithRuntimeHealth(
    storage,
    undefined,
    undefined,
    undefined,
    async () => {
      contributionCalls += 1
      return {
        runtimeFootprint: {
          inbox: { state: 'present', bytes: 123 },
        },
      }
    },
  )

  const health = await wrapped.health()
  assert.equal(contributionCalls, 0)
  assert.equal(health.details?.base, 'health')
  assert.equal(health.details?.runtimeFootprint, undefined)

  const diagnostics = await wrapped.diagnostics?.()
  assert.equal(contributionCalls, 1)
  assert.equal(diagnostics?.details?.base, 'diagnostics')
  assert.deepEqual(diagnostics?.details?.runtimeFootprint, {
    inbox: { state: 'present', bytes: 123 },
  })
})

test('deep diagnostics contribution 失败不会覆盖基础存储诊断', async () => {
  const storage = {
    async health() {
      return { ok: true }
    },
    async diagnostics() {
      return { ok: true, details: { base: 'diagnostics' } }
    },
  } as unknown as StorageService

  const wrapped = httpSurfacePluginInternals.storageWithRuntimeHealth(
    storage,
    undefined,
    undefined,
    undefined,
    async () => {
      throw new Error('footprint failed')
    },
  )

  const diagnostics = await wrapped.diagnostics?.()
  assert.equal(diagnostics?.ok, true)
  assert.equal(diagnostics?.details?.base, 'diagnostics')
  assert.match(String(diagnostics?.details?.diagnosticsContributionError), /footprint failed/)
})
