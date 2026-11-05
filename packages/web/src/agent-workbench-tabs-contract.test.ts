import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const work = readFileSync(new URL('./features/AgentWorkPage.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('./agents.css', import.meta.url), 'utf8')
const overviewCss = readFileSync(new URL('./agent-insights-responsive.css', import.meta.url), 'utf8')

test('Hermes Work matches the shared 1320px reading axis independently of overview grid', () => {
  assert.match(work, /className="page-content agents-content agent-work-content"/)
  assert.match(css, /\.agents-responsive-shell \.agent-work-page \.agent-work-content\s*\{[\s\S]*?max-width: var\(--al-workspace-content-max, 1320px\)/)
  assert.match(css, /\.agent-work-section \{ min-width: 0; padding: 15px 0 18px; \}/)
  assert.match(overviewCss, /\.agents-overview-layout \.agents-content \{ max-width: none/)
  assert.doesNotMatch(overviewCss, /\.agents-responsive-shell \.agents-content \{ max-width: none/)
})

test('two Work tabs are shared navigation without a redundant third page title', () => {
  assert.match(work, /<WorkspaceViewTabs\s+inline/)
  assert.match(work, /!\(boardAvailable && schedulesAvailable\) && <h2>/)
  assert.match(work, /activePanel==='boards' && boardAvailable/)
  assert.match(work, /activePanel==='schedules' && schedulesAvailable/)
  assert.doesNotMatch(work, /<h2>\{t\('work\.workspaceTitle'\)\}<\/h2>/)
})

test('board and schedule rows share the same compact structure and retain native actions', () => {
  assert.match(work, /response\.tasks\.map\(item => <div className="agent-work-record"/)
  assert.match(work, /response\.schedules\.map\(job=><div className="agent-work-record"/)
  assert.match(work, /className="agent-work-record-title"/)
  assert.match(work, /className="agent-work-record-meta"/)
  assert.match(work, /className="agent-work-record-details"/)
  assert.match(work, /<TaskRuns task=\{item\}/)
  assert.match(work, /onClick=\{\(\)=>openJob\(job\)\}/)
  assert.match(work, /kind:'cron\.run'/)
  assert.match(work, /kind:'cron\.cancel'/)
  assert.match(work, /kind:'cron\.remove'/)
  assert.doesNotMatch(work, /response\.schedules\.map\(job=><div className="asset-item"/)
  assert.match(css, /\.agent-work-record-line \{ display: flex/)
  assert.doesNotMatch(css.slice(css.indexOf('/* Hermes workbench:')), /!important/)
})

test('schedule metadata is separated and default native profile stays available in details', () => {
  assert.match(work, /formatAgentWorkSchedule\(job\.schedule/)
  assert.match(work, /job\.nextRunAt && <span>/)
  assert.match(work, /job\.profile!=='default' && <span>/)
  assert.match(work, /profile:job\.profile,jobId:job\.id/)
  assert.match(work, /job\.state==='scheduled'\?t\('work\.scheduleStateScheduled'\)/)
  assert.match(work, /projectsAvailable && \(!boardAvailable \|\| activePanel==='boards'\)/)
})
