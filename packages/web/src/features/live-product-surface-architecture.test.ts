import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const productSurfaceFiles = [
  './TaskCenterPage.tsx',
  './LiveTaskPage.tsx',
  './LiveNewTaskPanel.tsx',
  './ReviewPage.tsx',
].map(path => ({ path, source: readFileSync(new URL(path, import.meta.url), 'utf8') }))

test('统一 Product Surface 不直接依赖 Pi Live 兼容 Client 或页面', () => {
  for (const file of productSurfaceFiles) {
    assert.doesNotMatch(file.source, /piLiveApi|PiLivePage|PiLiveCompatibilityPage/, file.path)
  }
})

test('统一 Product Surface 不使用具体 Agent 名称决定行为', () => {
  const forbidden = [
    /sourceIds\.includes\(\s*['"](?:pi|hermes|claude-code|codex)['"]\s*\)/,
    /(?:sourceId|liveId|productId|agentId)\s*={2,3}\s*['"](?:pi|hermes|claude-code|codex)['"]/,
    /['"](?:pi|hermes|claude-code|codex)['"]\s*={2,3}\s*(?:sourceId|liveId|productId|agentId)/,
  ]
  for (const file of productSurfaceFiles) {
    for (const pattern of forbidden) assert.doesNotMatch(file.source, pattern, file.path)
  }
})

test('Review 通用产品层不保留 Pi 专属关系树命名', () => {
  const review = productSurfaceFiles.find(file => file.path === './ReviewPage.tsx')!.source
  assert.doesNotMatch(review, /pi-session-tree|local\.relationship\.piTree/)
  assert.match(review, /session-relationship-tree/)
  assert.match(review, /local\.relationship\.sessionTree/)
})

test('具体 Agent 的 Review 事件解释只能留在 Product Presentation 投影', () => {
  const presentation = readFileSync(new URL('./review-event-presentation.ts', import.meta.url), 'utf8')
  assert.match(presentation, /codex|claude-code|pi/)
  const review = productSurfaceFiles.find(file => file.path === './ReviewPage.tsx')!.source
  assert.doesNotMatch(review, /node\.sourceId\s*===\s*['"](?:pi|hermes|claude-code|codex)['"]/)
})


test('LiveTask 高级交互只消费通用 capability 与 control，不解析 Pi 原生字段', () => {
  const liveTask = productSurfaceFiles.find(file => file.path === './LiveTaskPage.tsx')!.source
  for (const capability of ['model-switching', 'thinking-control', 'extension-ui', 'recovery', 'steer', 'queue']) {
    assert.match(liveTask, new RegExp(`capabilities\\.includes\\(['"]${capability}['"]\\)`), capability)
  }
  assert.match(liveTask, /liveApi\.modelControl/)
  assert.match(liveTask, /liveApi\.respondToExtension/)
  assert.match(liveTask, /liveApi\.snapshot\([^\n]+leafIdRef\.current/)
  assert.doesNotMatch(liveTask, /extension_ui_request|modelId|provider/)
})
