import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const reviewPage = readFileSync(new URL('./ReviewPage.tsx', import.meta.url), 'utf8')
const piLivePage = readFileSync(new URL('./PiLivePage.tsx', import.meta.url), 'utf8')
const mainEntry = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8')

test('Task Review defaults to full observable events without a DOM adapter', () => {
  assert.match(reviewPage, /const \[showAllEvents, setShowAllEvents\] = useState\(true\)/)
  assert.doesNotMatch(reviewPage, /const \[showAllEvents, setShowAllEvents\] = useState\(false\)/)
})

test('Task Review 的历史 Thinking 默认折叠并保留 disclosure 交互', () => {
  assert.match(reviewPage, /<TaskThinking[\s\S]*?defaultExpanded=\{false\}/)
})

test('Task Review 将 commentary、reasoning 与工具统一放入默认折叠的思考过程', () => {
  assert.match(reviewPage, /label: '思考过程'/)
  assert.match(reviewPage, /entry\.type === 'process'/)
})

test('Pi Live defaults and resets to full observable events natively', () => {
  assert.match(piLivePage, /const \[showAllEvents, setShowAllEvents\] = useState\(true\)/)
  assert.match(piLivePage, /setShowAllEvents\(true\)/)
  assert.doesNotMatch(piLivePage, /setShowAllEvents\(false\)/)
})

test('legacy Task Surface MutationObserver compatibility layer is removed', () => {
  assert.equal(existsSync(new URL('../client/task-surface-defaults.ts', import.meta.url)), false)
  assert.doesNotMatch(mainEntry, /installTaskSurfaceDefaults|task-surface-defaults/)
})
