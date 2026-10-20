import test from 'node:test'
import assert from 'node:assert/strict'
import { auditAgentConvergenceSources } from './agent-convergence-ownership.mjs'

const reviewPath = 'packages/web/src/features/ReviewRoundPresentation.tsx'
const livePath = 'packages/web/src/features/LiveTaskPage.tsx'
const runtimePath = 'packages/web/src/components/LiveRuntimeDisclosures.tsx'

test('现存 Review 来源特判只允许减少，不允许增加新来源分支', () => {
  assert.deepEqual(auditAgentConvergenceSources({ [reviewPath]: "node.sourceId === 'codex'\nuser.sourceId === 'codex'" }), [])
  assert.equal(auditAgentConvergenceSources({ [reviewPath]: "node.sourceId === 'codex'\nuser.sourceId === 'codex'\nnode.sourceId === 'pi'" }).length, 1)
  assert.equal(auditAgentConvergenceSources({ [reviewPath]: "node.sourceId === 'codex'\nuser.sourceId === 'codex'\nnode.sourceId === 'codex'" }).length, 1)
  assert.deepEqual(auditAgentConvergenceSources({ [reviewPath]: "node.sourceId === 'codex'" }), [])
})

test('共享 Task 视图禁止品牌分支、旧 Pi 渲染和再次复制输入控件', () => {
  assert.equal(auditAgentConvergenceSources({ [livePath]: "if (productId === 'pi') {}" }).length, 1)
  assert.equal(auditAgentConvergenceSources({ [livePath]: "import { PiLiveTaskRound } from './PiLiveTaskRound'" }).length, 1)
  assert.equal(auditAgentConvergenceSources({ [livePath]: "<LiveMarkdownComposer />" }).length, 1)
  assert.equal(auditAgentConvergenceSources({ [livePath]: "<ComposerPillSelect />" }).length, 1)
  assert.equal(auditAgentConvergenceSources({ [livePath]: 'pi-live-'.repeat(28) }).length, 1)
  assert.deepEqual(auditAgentConvergenceSources({ [livePath]: 'pi-live-'.repeat(26) }), [])
})

test('Runtime Contribution 不再把文案当语义', () => {
  const stable = "function fieldSection(field) { return field.section ?? (field.kind === 'code' ? 'advanced' : 'status') }"
  assert.deepEqual(auditAgentConvergenceSources({ [runtimePath]: stable }), [])
  assert.equal(auditAgentConvergenceSources({ [runtimePath]: stable + "\nif (field.id === 'Main costs') {}" }).length, 1)
  assert.equal(auditAgentConvergenceSources({ [runtimePath]: "function fieldSection(field) { return 'status' }" }).length, 1)
})
