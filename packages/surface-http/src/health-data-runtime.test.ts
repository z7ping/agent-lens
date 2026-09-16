import assert from 'node:assert/strict'
import test from 'node:test'
import type { StorageService } from '@agent-lens/core'
import type { HealthResponseDto, StorageDiagnosticsResponseDto } from '@agent-lens/protocol'
import { startHttpSurface } from './server'

const worker = (role: 'writer' | 'reader', state: 'ready' | 'degraded') => ({
  state,
  role,
  protocolVersion: 1,
  pending: 0,
  maxPending: 1,
  requests: 2,
  completed: 2,
  timeouts: 0,
  durationMs: { last: 1, max: 2, p50: 1, p95: 2, p99: 2 },
})

test('/health mirrors Data Runtime health into the top-level protocol field', async () => {
  const dataRuntime = {
    ok: true,
    recovering: false,
    writer: worker('writer', 'ready'),
    reader: worker('reader', 'ready'),
  }
  const storage = {
    async health() {
      return {
        ok: true,
        schemaVersion: 21,
        details: { dataRuntime },
      }
    },
  } as unknown as StorageService
  const surface = await startHttpSurface(storage, { port: 0 })

  try {
    const response = await fetch(`http://${surface.host}:${surface.port}/api/v1/health`)
    assert.equal(response.status, 200)
    const body = await response.json() as HealthResponseDto
    assert.deepEqual(body.dataRuntime, dataRuntime)
    assert.deepEqual(body.storage.details?.dataRuntime, dataRuntime)
  } finally {
    await surface.dispose()
  }
})

test('/health keeps degraded Data Runtime explicit at protocol boundary', async () => {
  const dataRuntime = {
    ok: false,
    recovering: true,
    writer: worker('writer', 'degraded'),
    reader: worker('reader', 'ready'),
  }
  const storage = {
    async health() {
      return {
        ok: false,
        schemaVersion: 21,
        details: { dataRuntime },
      }
    },
  } as unknown as StorageService
  const surface = await startHttpSurface(storage, { port: 0 })

  try {
    const response = await fetch(`http://${surface.host}:${surface.port}/api/v1/health`)
    assert.equal(response.status, 503)
    const body = await response.json() as HealthResponseDto
    assert.equal(body.status, 'degraded')
    assert.equal(body.dataRuntime?.writer.state, 'degraded')
    assert.equal(body.dataRuntime?.reader.state, 'ready')
    assert.equal(body.dataRuntime?.recovering, true)
  } finally {
    await surface.dispose()
  }
})

test('/storage/diagnostics 使用独立响应契约返回深度存储诊断', async () => {
  let diagnosticsCalls = 0
  const storage = {
    async health() {
      return {
        ok: true,
        schemaVersion: 22,
        details: { dataGrowth: { capacity: { scope: 'hot-sqlite' } } },
      }
    },
    async diagnostics() {
      diagnosticsCalls += 1
      return {
        ok: true,
        schemaVersion: 22,
        details: {
          dataGrowth: {
            capacity: {
              scope: 'hot-sqlite',
              softLimitBytes: 512 * 1024 * 1024,
              longTermTotalLimitBytes: null,
            },
          },
          storageBreakdown: {
            available: true,
            basis: 'sqlite-dbstat-btree-aggregate',
            categories: {
              canonical: {
                usefulPayloadBytes: 12,
                unusedBytes: 0,
                allocatedBytes: 4096,
                tableAllocatedBytes: 2048,
                indexAllocatedBytes: 2048,
              },
            },
          },
          spaceRecovery: {
            freelist: {
              bytes: 4096,
              reusableInsideDatabase: true,
              shrinksDatabaseFileWithoutCompaction: false,
            },
          },
          growthMetrics: {
            canonicalGrowthRate: { state: 'snapshot-required' },
            storageAmplificationRate: { state: 'snapshot-required' },
          },
        },
      }
    },
  } as unknown as StorageService
  const surface = await startHttpSurface(storage, { port: 0 })

  try {
    const response = await fetch(
      `http://${surface.host}:${surface.port}/api/v1/storage/diagnostics`,
    )
    assert.equal(response.status, 200)
    const body = await response.json() as StorageDiagnosticsResponseDto
    assert.equal(diagnosticsCalls, 1)
    assert.equal(typeof body.generatedAt, 'string')
    assert.equal(body.storage.schemaVersion, 22)
    assert.equal(
      (body.storage.details?.dataGrowth as { capacity?: { scope?: string } })?.capacity?.scope,
      'hot-sqlite',
    )
    assert.equal(
      (body.storage.details?.spaceRecovery as { freelist?: { bytes?: number } })?.freelist?.bytes,
      4096,
    )
    assert.equal(
      (body.storage.details?.growthMetrics as {
        canonicalGrowthRate?: { state?: string }
      })?.canonicalGrowthRate?.state,
      'snapshot-required',
    )
    assert.equal('status' in body, false)
    assert.equal('runtime' in body, false)
  } finally {
    await surface.dispose()
  }
})
