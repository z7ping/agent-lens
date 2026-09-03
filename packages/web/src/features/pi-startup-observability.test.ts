import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('./PiLivePage.tsx', import.meta.url), 'utf8')
const disclosure = readFileSync(new URL('../components/PiStartupDisclosure.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../components/pi-startup-disclosure.css', import.meta.url), 'utf8')

test('Pi Live exposes real Runtime initialization stages, timings and failure location', () => {
  assert.match(page, /<PiStartupDisclosure/)
  assert.match(page, /event\.timings \?\? event\.initializationTimings/)
  assert.match(page, /initializationElapsedMs/)
  assert.match(disclosure, /state\.initializationTimings/)
  assert.match(disclosure, /启动 Runtime Worker/)
  assert.match(disclosure, /加载 Pi SDK/)
  assert.match(disclosure, /加载资源/)
  assert.match(disclosure, /创建 Pi Session/)
  assert.match(disclosure, /绑定扩展界面/)
  assert.match(disclosure, /卡在：/)
})

test('Pi startup detail mirrors actual loaded resource groups and extension startup output', () => {
  assert.match(page, /type === 'runtime_resources'/)
  assert.match(page, /type === 'runtime_output'/)
  assert.match(page, /startupResources/)
  assert.match(page, /startupOutput/)
  assert.match(disclosure, /label: 'Context'/)
  assert.match(disclosure, /label: 'Skills'/)
  assert.match(disclosure, /label: 'Prompts'/)
  assert.match(disclosure, /label: 'Extensions'/)
  assert.match(disclosure, /label: 'Themes'/)
  assert.match(disclosure, /\[启动输出\]/)
  assert.match(disclosure, /Pi v\{sdkVersion\}/)
})

test('Pi initialization disclosure collapses after ready and expands on failure', () => {
  assert.match(disclosure, /state\.status === 'ready'\) setExpanded\(false\)/)
  assert.match(disclosure, /state\.status === 'failed'\) setExpanded\(true\)/)
  assert.match(disclosure, /onToggle=\{event => setExpanded\(event\.currentTarget\.open\)\}/)
})

test('ready startup summary stays on one compact line', () => {
  assert.match(disclosure, /state\.status !== 'ready' && <small>/)
  assert.match(css, /\.pi-startup-summary-copy \{[^}]*display:\s*flex;/)
  assert.match(css, /\.pi-startup-disclosure\.is-ready:not\(\[open\]\) > summary \{[^}]*min-height:\s*34px;/)
})
