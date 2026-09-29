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
