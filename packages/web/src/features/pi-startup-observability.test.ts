import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('./PiLivePage.tsx', import.meta.url), 'utf8')
const disclosure = readFileSync(new URL('../components/PiStartupDisclosure.tsx', import.meta.url), 'utf8')

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

test('Pi initialization disclosure collapses after ready and expands on failure', () => {
  assert.match(disclosure, /state\.status === 'ready'\) setExpanded\(false\)/)
  assert.match(disclosure, /state\.status === 'failed'\) setExpanded\(true\)/)
  assert.match(disclosure, /onToggle=\{event => setExpanded\(event\.currentTarget\.open\)\}/)
})
