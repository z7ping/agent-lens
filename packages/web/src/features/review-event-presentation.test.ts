import assert from 'node:assert/strict'
import test from 'node:test'
import { reviewArtifactLabel, reviewArtifactSummary, reviewEventLabel } from './review-event-presentation'
import type { ReviewEventNodeDto } from '@agent-lens/protocol'

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
    const node = {
      kind: 'session.lifecycle', sourceId: 'pi', label: '会话生命周期', payload: { event: action },
    } as ReviewEventNodeDto
    assert.equal(reviewEventLabel(node), label)
  }
})
