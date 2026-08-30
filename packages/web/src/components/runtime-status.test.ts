import assert from 'node:assert/strict'
import test from 'node:test'
import type { HealthResponseDto } from '@agent-lens/protocol'
import { projectRuntimeStatus, resolveRuntimeEndpoint } from './runtime-status'

const health: HealthResponseDto = {
  status: 'ok',
  protocolVersion: '1.0',
  runtime: {
    owner: 'desktop',
    mode: 'managed',
    pid: 2345,
    startedAt: '2026-08-30T06:00:00.000Z',
  },
  storage: {
    ok: true,
    schemaVersion: 7,
    details: {
      sourceRuntime: { failed: 0 },
      unknownObservations: { total: 3 },
      coverage: { summary: { complete: 5, partial: 1, unavailable: 2, unknown: 0 } },
    },
  },
}

test('开发态连接详情展示实际 Runtime 代理端口', () => {
  const endpoint = resolveRuntimeEndpoint({
    isDevelopment: true,
    developmentPort: 56800,
    protocol: 'http:',
    hostname: '127.0.0.1',
    port: '5173',
  })

  assert.deepEqual(endpoint, { origin: 'http://127.0.0.1:56800', port: 56800 })
  assert.equal(projectRuntimeStatus(health, true, endpoint).summary, '运行正常 · 桌面端:56800')
})

test('安装态连接详情使用当前页面承载 Runtime 的地址', () => {
  const endpoint = resolveRuntimeEndpoint({
    isDevelopment: false,
    developmentPort: 56800,
    protocol: 'http:',
    hostname: '127.0.0.1',
    port: '56789',
  })

  assert.deepEqual(endpoint, { origin: 'http://127.0.0.1:56789', port: 56789 })
})

test('实时断开和来源失败不会误报运行正常', () => {
  const endpoint = { origin: 'http://127.0.0.1:56800', port: 56800 }
  const disconnected = projectRuntimeStatus(health, false, endpoint)
  assert.equal(disconnected.label, '实时断开')
  assert.equal(disconnected.tone, 'warning')

  const withFailure: HealthResponseDto = {
    ...health,
    storage: { ...health.storage, details: { sourceRuntime: { failed: 2 } } },
  }
  const failed = projectRuntimeStatus(withFailure, true, endpoint)
  assert.equal(failed.label, '来源异常')
  assert.equal(failed.failedSourceStages, 2)
  assert.equal(failed.tone, 'warning')
})

test('连接建立前保持明确的等待状态', () => {
  const status = projectRuntimeStatus(null, false, { origin: 'http://127.0.0.1:56800', port: 56800 })
  assert.equal(status.label, '连接中')
  assert.equal(status.owner, '等待 Runtime')
  assert.equal(status.tone, 'connecting')
})
