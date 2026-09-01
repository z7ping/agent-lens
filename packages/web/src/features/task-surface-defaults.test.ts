import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const reviewPage = readFileSync('packages/web/src/features/ReviewPage.tsx', 'utf8')
const piLivePage = readFileSync('packages/web/src/features/PiLivePage.tsx', 'utf8')
const mainEntry = readFileSync('packages/web/src/main.tsx', 'utf8')

test('Task Review defaults to full observable events without a DOM adapter', () => {
  assert.match(reviewPage, /const \[showAllEvents, setShowAllEvents\] = useState\(true\)/)
  assert.doesNotMatch(reviewPage, /const \[showAllEvents, setShowAllEvents\] = useState\(false\)/)
})

test('Pi Live defaults and resets to full observable events natively', () => {
  assert.match(piLivePage, /const \[showAllEvents, setShowAllEvents\] = useState\(true\)/)
  assert.match(piLivePage, /setShowAllEvents\(true\)/)
  assert.doesNotMatch(piLivePage, /setShowAllEvents\(false\)/)
})

test('legacy Task Surface MutationObserver compatibility layer is removed', () => {
  assert.equal(existsSync('packages/web/src/client/task-surface-defaults.ts'), false)
  assert.doesNotMatch(mainEntry, /installTaskSurfaceDefaults|task-surface-defaults/)
})
