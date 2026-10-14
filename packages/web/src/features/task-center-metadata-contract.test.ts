import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../components/workspace-sidebar.css', import.meta.url), 'utf8')
const shell = readFileSync(new URL('../shell-responsive.css', import.meta.url), 'utf8')
const page = readFileSync(new URL('./TaskCenterPage.tsx', import.meta.url), 'utf8')
const review = readFileSync(new URL('./ReviewPage.tsx', import.meta.url), 'utf8')

test('侧栏只在 Task Center 桌面态扩展，其他工作区、窄屏和 40px 折叠态不变', () => {
  assert.match(app, /onReview \? 'is-task-center' : ''/)
  assert.match(css, /@media \(min-width: 1200px\)[\s\S]*?\.app-shell\.is-task-center:not\(\.is-sidebar-collapsed\)\s*\{\s*grid-template-columns: 340px minmax\(0, 1fr\)/)
  assert.match(css, /@media \(min-width: 992px\) and \(max-width: 1199\.98px\)[\s\S]*?\.app-shell\.is-task-center:not\(\.is-sidebar-collapsed\)\s*\{\s*grid-template-columns: 300px minmax\(0, 1fr\)/)
  assert.match(css, /\.app-shell\.is-sidebar-collapsed\s*\{\s*grid-template-columns: 40px minmax\(0, 1fr\)/)
  assert.match(shell, /@media \(max-width: 767\.98px\)[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/)
})

test('会话列表展示最近观测并保留真实创建时间，绝不当成同一个时间字段', () => {
  assert.match(page, /sessionTimeFact\(item\.startedAt, item\.endedAt\)/)
  assert.match(page, /center\.time\.startedAt/)
  assert.match(page, /center\.time\.lastActivityAt/)
  assert.match(page, /center\.time\.onlyStartedAt/)
  assert.match(page, /<time dateTime=\{moment\?\.at\} title=\{timeTooltip \|\| undefined\}/)
  assert.match(page, /window\.setInterval\(refreshClock, 60_000\)/)
  assert.match(page, /document\.addEventListener\('visibilitychange', refreshClock\)/)
  assert.match(page, /taskDayGroup\(item\.at, now\)/)
})

test('Review 的创建时间与最后观测独立显示，避免缺失结束时间导致创建时间消失', () => {
  assert.match(review, /infoItems=\{taskDetailModel \? \[/)
  assert.match(review, /taskDetailModel\.startedAt && Number\.isFinite\(Date\.parse\(taskDetailModel\.startedAt\)\)/)
  assert.match(review, /taskDetailModel\.endedAt && Number\.isFinite\(Date\.parse\(taskDetailModel\.endedAt\)\)/)
})
