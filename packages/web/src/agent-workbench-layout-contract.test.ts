import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const work = readFileSync(new URL('./features/AgentWorkPage.tsx', import.meta.url), 'utf8')
const agentsCss = readFileSync(new URL('./agents.css', import.meta.url), 'utf8')
const zh = readFileSync(new URL('./i18n/zh-CN/agents.ts', import.meta.url), 'utf8')
const en = readFileSync(new URL('./i18n/en-US/agents.ts', import.meta.url), 'utf8')

test('Hermes workbench has a single toolbar and reuses shared inline navigation', () => {
  assert.match(work, /<header className="agent-work-toolbar">/)
  assert.match(work, /<WorkspaceViewTabs\s+inline/)
  assert.match(work, /<IconButton[^>]+aria-label=\{t\('work\.refresh'\)\}/)
  assert.match(work, /<Popover open=\{workMenuOpen\}/)
  assert.match(work, /setAccessChange\(!accessEnabled\)/)
  assert.match(work, /<Dialog open=\{accessChange!==null\}/)
  assert.match(work, /<Dialog open=\{Boolean\(pendingAction\)\}/)
  assert.doesNotMatch(work, /<h3>\{t\('work\.boardTasks'\)\}<\/h3>/)
})

test('single selected board shows its name, multi-board preserves native selection and pagination', () => {
  assert.match(work, /response\.boardsTotal>1 \|\| response\.boardsHasMore \|\| boardOffset>0 \|\| !response\.selectedBoard/)
  assert.match(work, /selectedOption=\{response\.selectedBoard \?/)
  assert.match(work, /item\.id==='default' && item\.name==='default'/)
  assert.match(work, /response\.boardsHasMore && <Button/)
  assert.doesNotMatch(work, /<span>\{response\.boardsTotal\}<\/span>/)
})

test('empty board, schedule and project states do not expose fake zero loads', () => {
  assert.match(work, /<div className="agent-work-empty" role="status">/)
  assert.match(work, /board\?\.taskCount===0/)
  assert.match(work, /offset>0 \|\| response\.tasksHasMore/)
  assert.match(work, /projectsAvailable && \(response\.projects\.length>0 \|\| response\.projectsTotal>0/)
  assert.doesNotMatch(work, /<span>\{t\('work\.loaded'\)\} 0 \/ 0<\/span>/)
})

test('Workbench styles are scoped and reuse shared primitive tokens', () => {
  const workCss = agentsCss.slice(agentsCss.indexOf('/* Hermes workbench layout:'))
  assert.match(workCss, /\.agent-work-toolbar\s*\{/)
  assert.match(workCss, /\.agent-work-empty\s*\{/)
  assert.match(workCss, /var\(--al-line\)/)
  assert.doesNotMatch(workCss, /!important/)
  for (const messages of [zh, en]) {
    for (const key of ['workspaceTitle', 'defaultBoard', 'moreActions', 'taskCount', 'scheduleCount', 'tasksUnavailable']) {
      assert.match(messages, new RegExp('\\b'+key+':'))
    }
  }
})
