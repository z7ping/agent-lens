import test from 'node:test'
import assert from 'node:assert/strict'
import { auditAgentConvergenceSources } from './agent-convergence-ownership.mjs'

const reviewPath = 'packages/web/src/features/ReviewRoundPresentation.tsx'
const livePath = 'packages/web/src/features/LiveTaskPage.tsx'
const runtimePath = 'packages/web/src/components/LiveRuntimeDisclosures.tsx'
const composerPath = 'packages/web/src/components/TaskSessionComposer.tsx'

test('共享 Review 不再允许任何新增 Agent 来源条件分支', () => {
  assert.deepEqual(auditAgentConvergenceSources({ [reviewPath]: 'const text = taskUserRequestText(node.text)' }), [])
  assert.equal(auditAgentConvergenceSources({ [reviewPath]: "node.sourceId === 'codex'" }).length, 1)
  assert.equal(auditAgentConvergenceSources({ [reviewPath]: "node.sourceId === 'pi'" }).length, 1)
  assert.equal(auditAgentConvergenceSources({ [reviewPath]: "node.sourceId === 'hermes'" }).length, 1)
})

test('共享 Task 视图禁止品牌分支、旧 Pi 渲染和再次复制输入控件', () => {
  assert.equal(auditAgentConvergenceSources({ [livePath]: "if (productId === 'pi') {}" }).length, 1)
  assert.equal(auditAgentConvergenceSources({ [livePath]: "import { PiLiveTaskRound } from './PiLiveTaskRound'" }).length, 1)
  assert.equal(auditAgentConvergenceSources({ [livePath]: "<LiveMarkdownComposer />" }).length, 1)
  assert.equal(auditAgentConvergenceSources({ [livePath]: "<ComposerPillSelect />" }).length, 1)
  assert.equal(auditAgentConvergenceSources({ [livePath]: 'pi-live-'.repeat(28) }).length, 1)
  assert.equal(auditAgentConvergenceSources({ [livePath]: 'pi-live-'.repeat(1) }).length, 1)
  assert.deepEqual(auditAgentConvergenceSources({ [livePath]: 'live-task-'.repeat(26) }), [])
})

test('唯一 TaskSessionComposer 可以持有编辑器与模型选择器，其他页面不得持有', () => {
  const markup = '<LiveMarkdownComposer /><ComposerPillSelect />'
  assert.deepEqual(auditAgentConvergenceSources({ [composerPath]: markup }), [])
  assert.equal(auditAgentConvergenceSources({ [livePath]: markup }).length, 1)
})

test('Runtime Contribution 不再把文案当语义', () => {
  const stable = "function fieldSection(field) { switch (field.section) { default: return 'status' } }\nconst performanceFields = fields.filter(field => fieldSection(field) === 'performance')"
  assert.deepEqual(auditAgentConvergenceSources({ [runtimePath]: stable }), [])
  assert.equal(auditAgentConvergenceSources({ [runtimePath]: stable + "\nif (field.id === 'Main costs') {}" }).length, 1)
  assert.equal(auditAgentConvergenceSources({ [runtimePath]: "function fieldSection(field) { return 'status' }" }).length, 1)
})

test('共享 UI 不可通过对象属性访问规避 Agent ID 门禁', () => {
  for (const condition of [
    "node.sourceId === 'codex'",
    "runtime?.productId === 'pi'",
    "state.runtime.liveId !== 'hermes'",
    "'claude-code' === session.agentId",
    "'codex' !== state?.sourceId",
  ]) {
    assert.equal(auditAgentConvergenceSources({ [livePath]: condition }).length, 1, condition)
  }
})

test('共享 Live CSS 不能恢复旧 Pi 专有 class', () => {
  const path = 'packages/web/src/live-task.css'
  assert.deepEqual(auditAgentConvergenceSources({ [path]: '.live-task-reader { display: block }' }), [])
  assert.equal(auditAgentConvergenceSources({ [path]: '.pi-live-reader { display: block }' }).length, 1)
})

test('共享 Live 投影同样禁止来源 ID 特判', () => {
  const path = 'packages/web/src/features/live-task-projection.ts'
  assert.equal(auditAgentConvergenceSources({ [path]: "if (adapter.productId === 'pi') {}" }).length, 1)
})

test('Runtime performance 分组不得退回为 Pi 专属字段识别', () => {
  const path = 'packages/web/src/components/LiveRuntimeDisclosures.tsx'
  const oldOnly = "function fieldSection(field) { return 'status' }\nconst startupMetrics = fields.find(field => field.id === 'startup.metrics')"
  assert.equal(auditAgentConvergenceSources({ [path]: oldOnly }).length, 1)
})
