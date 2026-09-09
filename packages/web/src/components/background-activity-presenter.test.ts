import assert from 'node:assert/strict'
import test from 'node:test'
import type { BackgroundActivityResponseDto } from '@agent-lens/protocol'
import { backgroundActivityLabel, summarizeBackgroundActivity } from './background-activity-presenter'

const generatedAt = '2026-09-09T10:00:00.000Z'

test('background activity uses concrete user-facing actions', () => {
  assert.equal(backgroundActivityLabel({
    id: 'pi-history',
    kind: 'source-history',
    state: 'running',
    sourceId: 'pi',
    updatedAt: generatedAt,
  }, 'Pi'), '正在同步 Pi 历史会话')

  assert.equal(backgroundActivityLabel({
    id: 'tool-facts',
    kind: 'projection-rebuild',
    state: 'running',
    scope: 'tool-usage-facts-v18',
    updatedAt: generatedAt,
  }), '正在整理工具使用数据')
})

test('background activity summary prefers active work and only surfaces fresh completion or failure', () => {
  const active: BackgroundActivityResponseDto = {
    generatedAt,
    active: [{
      id: 'replay',
      kind: 'parser-replay',
      state: 'running',
      updatedAt: generatedAt,
    }, {
      id: 'compression',
      kind: 'source-record-compression',
      state: 'pending',
      updatedAt: generatedAt,
    }],
    recent: [],
  }
  assert.deepEqual(summarizeBackgroundActivity(active, Date.parse(generatedAt)), {
    tone: 'active',
    label: '正在重新解析历史会话 · 另有 1 项',
  })

  const recent: BackgroundActivityResponseDto = {
    generatedAt,
    active: [],
    recent: [{
      id: 'done',
      kind: 'deferred-indexes',
      state: 'completed',
      updatedAt: generatedAt,
      completedAt: generatedAt,
    }],
  }
  assert.equal(summarizeBackgroundActivity(recent, Date.parse(generatedAt) + 10_000).label, '后台处理完成')
  assert.deepEqual(summarizeBackgroundActivity(recent, Date.parse(generatedAt) + 60_000), {
    tone: 'idle',
    label: '后台活动',
  })
})
