import assert from 'node:assert/strict'
import test from 'node:test'
import { isConsolidatedFileChangeEvent, reviewArtifactLabel, reviewArtifactSummary, reviewEventLabel } from './review-event-presentation'
import type { ReviewEventNodeDto, TaskFileChangesResponseDto } from '@agent-lens/protocol'

test('仅将完整覆盖的成功文件事件收入集中卡片的原始记录组', () => {
  const event: ReviewEventNodeDto = { type: 'event', id: 'event', at: '2026-10-16T00:00:00Z',
    capturedAt: '2026-10-16T00:00:00Z', sourceId: 'codex', kind: 'artifact.action', category: 'artifact',
    label: '文件变更', evidence: [], observationIds: [],
    payload: { action: 'file.change', status: 'completed', changes: { 'a.ts': { type: 'update' } } } }
  const changes: TaskFileChangesResponseDto = { logicalSessionId: 'session',
    items: [{ path: 'a.ts', changeType: 'unknown', firstChangedAt: event.at, lastChangedAt: event.at, evidence: ['tool'], confidence: 'medium' }],
    summary: { count: 1, exactCount: 0, observedCount: 1 }, meta: { protocolVersion: '1.0', generatedAt: event.at } }
  assert.equal(isConsolidatedFileChangeEvent(event, changes), true)
  assert.equal(isConsolidatedFileChangeEvent(event, null), false)
  assert.equal(isConsolidatedFileChangeEvent(event, { ...changes, items: [] }), false)
  assert.equal(isConsolidatedFileChangeEvent({ ...event, payload: { action: 'file.change', status: 'failed', changes: { 'a.ts': {} } } }, changes), false)
  assert.equal(isConsolidatedFileChangeEvent({ ...event, payload: { action: 'image.view', status: 'completed', changes: { 'a.ts': {} } } }, changes), false)
})

test('产物事件展示具体文件动作和目标，而不是笼统的产物操作', () => {
  const payload = {
    action: 'file.change',
    changes: {
      'packages/web/src/features/ReviewPage.tsx': { type: 'update' },
    },
  }
  assert.equal(reviewArtifactLabel(payload), '修改文件')
  assert.equal(reviewArtifactSummary(payload), 'ReviewPage.tsx')
})

test('多个文件变更保留首个文件名和准确数量', () => {
  const payload = {
    action: 'file.change',
    changes: {
      'src/a.ts': { type: 'update' },
      'src/b.ts': { type: 'create' },
    },
  }
  assert.equal(reviewArtifactLabel(payload), '文件变更')
  assert.equal(reviewArtifactSummary(payload), 'a.ts 等 2 个文件')
})

test('Codex 原生 image.generation 与通用 image.generate 都显示为图片生成', () => {
  for (const action of ['image.generation', 'image.generate']) {
    assert.equal(reviewArtifactLabel({ action }), '生成图片')
    assert.equal(reviewArtifactSummary({ action, path: '/workspace/generated.png' }), '/workspace/generated.png')
  }
})


test('Pi 真实生命周期事件获得友好标签，同时原始事件保持可检查', () => {
  const cases = [
    ['assistant.error', '助手执行错误'],
    ['assistant.cancelled', '助手执行已取消'],
    ['pi.bash_execution', '终端执行'],
    ['pi.bash_result', '终端执行结果'],
  ] as const
  for (const [action, label] of cases) {
    const node: ReviewEventNodeDto = {
      type: 'event',
      id: `lifecycle:${action}`,
      at: '2026-10-16T00:00:00.000Z',
      capturedAt: '2026-10-16T00:00:00.000Z',
      sourceId: 'pi',
      kind: 'session.lifecycle',
      category: 'lifecycle',
      label: '会话生命周期',
      payload: { event: action },
      evidence: [],
      observationIds: [],
    }
    assert.equal(reviewEventLabel(node), label)
  }
})

test('Canonical kind/action 语义跨来源保持同一事件文案', () => {
  const node: ReviewEventNodeDto = {
    type: 'event', id: 'event', at: '2026-10-20T00:00:00Z',
    capturedAt: '2026-10-20T00:00:00Z', sourceId: 'pi',
    kind: 'session.lifecycle', category: 'lifecycle', label: 'native lifecycle',
    payload: { event: 'assistant.error' }, evidence: [], observationIds: [],
  }
  for (const sourceId of ['pi', 'codex', 'claude-code', 'hermes', 'unknown-agent']) {
    assert.equal(reviewEventLabel({ ...node, sourceId }), '助手执行错误')
    assert.equal(reviewEventLabel({ ...node, sourceId, payload: { event: 'turn.error' } }), '轮次执行失败')
  }
})

test('新原生事件保留一致的人类可读标签，且不因跨 Agent 丢失语义', () => {
  const cases: Array<[string, ReviewEventNodeDto['kind'], string, string]> = [
    ['pi', 'session.lifecycle', 'context.edited', '上下文条目已编辑'],
    ['claude-code', 'session.lifecycle', 'task.completed', '任务已完成'],
    ['claude-code', 'session.lifecycle', 'turn.error', '轮次执行失败'],
    ['claude-code', 'context.injected', 'instructions.loaded', '项目规则已加载'],
    ['hermes', 'session.lifecycle', 'session.reset', '会话已重置'],
    ['hermes', 'permission.response', 'human.input.resolved', '权限响应'],
    ['opencode', 'session.lifecycle', 'subtask.requested', '子任务已请求'],
    ['opencode', 'session.lifecycle', 'model.retry', '模型请求重试'],
    ['dsh', 'context.compaction', '', '上下文压缩'],
  ]
  for (const [sourceId, kind, event, expected] of cases) {
    const node: ReviewEventNodeDto = {
      type: 'event',
      id: `${sourceId}:${kind}:${event}`,
      at: '2026-10-16T00:00:00.000Z',
      capturedAt: '2026-10-16T00:00:00.000Z',
      sourceId,
      kind,
      category: 'lifecycle',
      label: '通用事件',
      payload: { event },
      evidence: [],
      observationIds: [],
    }
    assert.equal(reviewEventLabel(node), expected, `${sourceId}/${event}`)
  }
  assert.equal(reviewArtifactLabel({ action: 'file.patch', files: ['a.ts'] }), '应用文件补丁')
  assert.equal(reviewArtifactSummary({ action: 'file.patch', files: ['/workspace/src/a.ts', 'b.ts'] }), 'a.ts 等 2 个文件')
  assert.equal(reviewArtifactLabel({ action: 'file.attached', filename: 'image.png' }), '添加附件')
  assert.equal(reviewArtifactSummary({ action: 'file.attached', filename: 'image.png' }), 'image.png')
})
