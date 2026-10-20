import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const review = [
  'review-session-format.ts', 'ReviewEvidenceInspector.tsx', 'ReviewRoundPresentation.tsx',
  'review-reader-position.ts', 'use-review-session.ts', 'ReviewPage.tsx',
].map(file => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')).join('\n')
const live = readFileSync(new URL('./LiveTaskTimeline.tsx', import.meta.url), 'utf8')
const liveProjection = readFileSync(new URL('./live-task-projection.ts', import.meta.url), 'utf8')
const session = readFileSync(new URL('./TaskSessionContent.tsx', import.meta.url), 'utf8')
const thinking = readFileSync(new URL('./TaskThinking.tsx', import.meta.url), 'utf8')
const round = readFileSync(new URL('./TaskRound.tsx', import.meta.url), 'utf8')
const tool = readFileSync(new URL('./TaskToolRow.tsx', import.meta.url), 'utf8')
const message = readFileSync(new URL('./TaskMessage.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../task-detail.css', import.meta.url), 'utf8')

test('Review summary-mode 外层统计使用 Process Summary 且重正文可被虚拟卸载', () => {
  assert.match(review, /projectReviewInteractionToolStats\(interaction\)/)
  assert.doesNotMatch(review, /<VirtualRoundMount[\s\S]{0,260}\bretainMounted\b/)
})

test('Review 与 Live 均保留展开意图，Review 的 revision 更新可重拉', () => {
  assert.match(review, /expansionStore\.get\(summary\.id\) === true[\s\S]{0,120}startProcessLoad\(summary\)/)
  assert.match(live, /expansionStore=\{processExpansionStore\}/)
})

test('处理详情的 Thinking 摘要两行并将所有折叠箭头放在右侧', () => {
  assert.match(thinking, /<span className="task-thinking-summary-meta">[\s\S]*?\{meta\}[\s\S]*?<DisclosureChevron\/>/)
  assert.match(styles, /\.task-thinking-preview \{[^}]*-webkit-line-clamp: 2/)
  assert.match(review, /preview: item\.node\.text\.replace/)
})

test('Shell 在折叠态显示两行命令预览，展开复用原有输入和输出区域', () => {
  assert.match(tool, /commandTarget[\s\S]*?<code className="task-tool-command-preview"/)
  assert.match(tool, /data-tool-section="input"/)
  assert.match(tool, /data-tool-section="output"/)
  assert.match(tool, /task-tool-status-label/)
  assert.match(styles, /\.task-surface \.task-tool-command-preview \{ font-family: var\(--font-mono\); \}/)
})

test('Assistant 复制、源码和证据入口共享同一行', () => {
  assert.match(message, /className="markdown-message-actions"[\s\S]*?className="task-message-actions">\{actions\}<\/span>/)
  assert.match(message, /actions && \(!text \|\| awaitingFirstContent\)/)
  assert.match(styles, /\.task-message-actions \{[^}]*flex-wrap: nowrap/)
})

test('Task disclosure 只把真实用户 toggle 写回展开意图，程序同步事件必须忽略', () => {
  const syncEffect = thinking.match(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[defaultExpanded, expansionStore, model\.id\]\)/)?.[1] ?? ''
  assert.ok(syncEffect)
  assert.doesNotMatch(syncEffect, /onExpandedChange/)
  assert.match(thinking, /const next = event\.currentTarget\.open[\s\S]*?if \(next === expanded\) return[\s\S]*?onExpandedChange\?\.\(next\)/)
  assert.match(round, /const onToggle = \(open: boolean\) => \{[\s\S]*?if \(open === expanded\) return/)
})


test('Review 依据 Final 收束，Live 活动尾轮不在工具间隙误判完成', () => {
  assert.match(review, /const hasFinalAnswer = Boolean\(lastAssistantId\)[\s\S]*?const resolvedProcessState = hasFinalAnswer \? 'settled' : round\.state/)
  assert.match(review, /state=\{resolvedProcessState\}/)
  assert.match(liveProjection, /active: activeItems\.length[\s\S]*?round\.model\.state !== 'running'/)
})

test('Review Process 对中间 Assistant\/Commentary 明确标识为过程输出', () => {
  assert.match(review, /<TaskSessionProcessText/)
})

test('Live 处理详情不会因运行状态变化被自动收起', () => {
  assert.doesNotMatch(session, /autoCollapseOnSettle/)
  assert.doesNotMatch(thinking, /autoCollapseOnSettle/)
  assert.match(live, /expansionStore=\{processExpansionStore\}/)
})
