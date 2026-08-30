import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReviewResponseDto, ReviewSessionDetailDto } from '@agent-lens/protocol'
import { AgentLensApi } from './api'

const summary = {
  id: 'session-1',
  installationId: 'installation-1',
  productId: 'codex',
  sourceIds: ['codex'],
  title: 'Codex 原生线程摘要',
  preview: '请检查 Windows 安装器图标问题',
  startedAt: '2026-08-20T01:00:00.000Z',
  endedAt: '2026-08-20T01:10:00.000Z',
  durationMs: 600_000,
  observationCount: 3,
  interactionCount: 1,
  toolCount: 0,
  errorCount: 0,
  hasErrors: false,
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('会话列表保留 Agent 原生标题，preview 仅作为兜底数据', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => jsonResponse({
    items: [summary],
    meta: { protocolVersion: '1.0', count: 1, hasMore: false, generatedAt: '2026-08-20T02:00:00.000Z' },
  } satisfies ReviewResponseDto)
  try {
    const result = await new AgentLensApi().review({ sourceId: '', projectId: '', range: 'all', status: 'all', search: '' })
    assert.equal(result.items[0]?.title, 'Codex 原生线程摘要')
    assert.equal(result.items[0]?.preview, '请检查 Windows 安装器图标问题')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('右侧会话详情同样保留 Agent 原生标题', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => jsonResponse({
    ...summary,
    interactions: [],
    page: { count: 0, hasMore: false, direction: 'forward', filter: 'all' },
  } satisfies ReviewSessionDetailDto)
  try {
    const result = await new AgentLensApi().reviewDetail('session-1')
    assert.equal(result.title, 'Codex 原生线程摘要')
    assert.equal(result.preview, '请检查 Windows 安装器图标问题')
  } finally {
    globalThis.fetch = originalFetch
  }
})
