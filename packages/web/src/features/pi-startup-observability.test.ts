import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = [
  readFileSync(new URL('./LiveTaskPage.tsx', import.meta.url), 'utf8'),
  readFileSync(new URL('./use-live-task-runtime.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./use-live-task-history.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./use-live-task-actions.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./live-task-state.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./live-task-queue.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./live-task-input.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./LiveTaskTimeline.tsx', import.meta.url), 'utf8'),
  readFileSync(new URL('./live-task-history-window.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./task-live-runtime.ts', import.meta.url), 'utf8')
].join('\n')
const runtime = readFileSync(new URL('../components/LiveRuntimeDisclosures.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../components/live-runtime-disclosure.css', import.meta.url), 'utf8')

test('统一 Live 通过 Runtime Disclosure 获取各 Agent 原生启动阶段和耗时', () => {
  assert.match(page, /liveApi\.runtimeDisclosures\(/)
  assert.match(page, /<LiveRuntimeDisclosures/)
  assert.match(page, /runtimeDisclosures\.every\(item => !item\.lifecycle\)/)
  assert.match(runtime, /lifecycle\.stages\.map/)
  assert.match(runtime, /field\.id === 'startup.metrics'/)
  assert.match(runtime, /field\.id === 'startup.metrics'/)
  assert.match(runtime, /lifecycle\.elapsedMs/)
})

test('启动成功默认收起、失败保持详情，资源与诊断继续可见', () => {
  assert.match(runtime, /setExpanded\(lifecycle\.status !== 'ready' \|\| needsAttention/)
  assert.match(runtime, /stage\.status === 'failed'/)
  assert.match(runtime, /lifecycle\.resources/)
  assert.match(runtime, /group\.groupId/)
  assert.match(runtime, /lifecycle\.resources/)
  assert.match(runtime, /lifecycle\.resources/)
  assert.match(runtime, /lifecycle\.resources/)
})

test('启动进度与失败信息继续使用统一的样式和可访问状态', () => {
  assert.match(runtime, /live-runtime-disclosure live-runtime-lifecycle/)
  assert.match(page, /live-task-startup-spotlight/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
})

test('就绪伴随启动警告依然展开，显示结构化来源和冲突归属', () => {
  assert.match(runtime, /needsAttention/)
  assert.match(runtime, /item\.diagnostics/)
  assert.match(runtime, /live-runtime-startup-issues/)
  assert.match(runtime, /winnerPath/)
  assert.match(css, /has-startup-issues/)
})
