import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('./LiveTaskPage.tsx', import.meta.url), 'utf8')
const runtime = readFileSync(new URL('../components/LiveRuntimeDisclosures.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../components/pi-startup-disclosure.css', import.meta.url), 'utf8')

test('统一 Live 通过 Runtime Disclosure 获取各 Agent 原生启动阶段和耗时', () => {
  assert.match(page, /liveApi\.runtimeDisclosures\(/)
  assert.match(page, /<LiveRuntimeDisclosures/)
  assert.match(page, /runtimeDisclosures\.every\(item => !item\.lifecycle\)/)
  assert.match(runtime, /lifecycle\.stages\.map/)
  assert.match(runtime, /field\.id === 'Initialization stages'/)
  assert.match(runtime, /field\.id === 'Startup metrics'/)
  assert.match(runtime, /lifecycle\.elapsedMs/)
})

test('启动成功默认收起、失败保持详情，资源与诊断继续可见', () => {
  assert.match(runtime, /setExpanded\(lifecycle\.status !== 'ready'\)/)
  assert.match(runtime, /stage\.status === 'failed'/)
  assert.match(runtime, /lifecycle\.resources/)
  assert.match(runtime, /group\.groupId/)
  assert.match(runtime, /field\.id === 'Contexts'/)
  assert.match(runtime, /field\.id === 'Skills'/)
  assert.match(runtime, /field\.id === 'Extensions'/)
})

test('启动进度与失败信息继续使用统一的样式和可访问状态', () => {
  assert.match(runtime, /pi-startup-disclosure live-runtime-lifecycle/)
  assert.match(page, /pi-live-startup-spotlight/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
})
