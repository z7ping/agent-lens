import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('./features/AgentWorkPage.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./agents.css', import.meta.url), 'utf8')
const zh = readFileSync(new URL('./i18n/zh-CN/agents.ts', import.meta.url), 'utf8')
const en = readFileSync(new URL('./i18n/en-US/agents.ts', import.meta.url), 'utf8')

test('cron execution history uses the shared disclosure and never renders 200 rows by default', () => {
  assert.match(page, /<Disclosure className="agent-work-history"/)
  assert.match(page, /visibleAgentWorkExecutions\(selectedExecutions,showAllExecutions,PREVIEW_EXECUTION_COUNT\)/)
  assert.match(page, /const PREVIEW_EXECUTION_COUNT = 5/)
  assert.match(page, /selectedExecutions\.length>PREVIEW_EXECUTION_COUNT/)
  assert.match(page, /setShowAllExecutions\(value=>!value\)/)
  assert.match(page, /response\.executionsHasMore/)
  assert.match(page, /goExecutionPage\(job,executionOffset\+MAX_EXECUTION_PAGE\)/)
  assert.doesNotMatch(page, /response\.executions\.filter\(run=>run\.jobId===job\.id.*\.map\(run=/)
})

test('status and delivery are distinct sourced facts; repeated suppressed delivery is summarized', () => {
  assert.match(page, /agentWorkExecutionStatusKey\(run\.status\)/)
  assert.match(page, /agentWorkDeliveryKey\(run\.deliveryOutcome\)/)
  assert.match(page, /selectedExecutions\.every\(run=>run\.deliveryOutcome==='suppressed'\)/)
  assert.match(page, /run\.deliveryOutcome && !sharedSuppressedDelivery/)
  assert.match(page, /run\.error && <div className="agent-path-error" role="alert">/)
  assert.match(page, /<time dateTime=\{run\.startedAt \?\? run\.claimedAt\}/)
  assert.match(styles, /\.agent-work-execution-row \{[\s\S]*?grid-template-columns/)
  for (const messages of [zh, en]) {
    for (const key of ['executionCompleted', 'executionFailed', 'deliverySuppressed', 'deliverySuppressedPage', 'showAllExecutions']) {
      assert.match(messages, new RegExp('\\b'+key+':'))
    }
  }
})

test('cron output uses existing disclosure only when there is actual output, loading or an error', () => {
  assert.match(page, /<Disclosure className="agent-work-output"/)
  assert.match(page, /cronOutputLoading \|\| Boolean\(cronOutputError\) \|\| Boolean\(cronOutput\?\.files\.length\)/)
  assert.match(page, /<MarkdownContent text=\{cronOutput\.preview\.text\}\/>/)
  assert.match(page, /onClick=\{\(\)=>void loadOutput\(job,file\.name,outputOffset\)\}/)
  assert.doesNotMatch(page, /<div className="section-heading-row"><h3>\{t\('work\.runs'\)\}<\/h3><\/div>/)
})
