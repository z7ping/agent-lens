import assert from 'node:assert/strict'
import test from 'node:test'
import { reviewArtifactLabel, reviewArtifactSummary } from './review-event-presentation'

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
