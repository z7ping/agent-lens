import { readFileSync } from 'node:fs'

const mainSource = readFileSync('packages/web/src/main.tsx', 'utf8')
const clientModel = readFileSync('packages/web/src/client/model.ts', 'utf8')
const reviewPage = readFileSync('packages/web/src/features/ReviewPage.tsx', 'utf8')
const taskMessage = readFileSync('packages/web/src/features/TaskMessage.tsx', 'utf8')
const taskToolGroup = readFileSync('packages/web/src/features/TaskToolGroup.tsx', 'utf8')
const reviewPresentation = readFileSync('packages/web/src/features/review-interaction-presentation.ts', 'utf8')
const taskDetailCss = readFileSync('packages/web/src/task-detail.css', 'utf8')
const reviewCss = readFileSync('packages/web/src/review.css', 'utf8')
const longCss = readFileSync('packages/web/src/review-long-session.css', 'utf8')

for (const label of ['从头查看', '跳到最新', '有新记录']) {
  if (!reviewPage.includes(label)) throw new Error(`正式任务复盘缺少关键长会话操作：${label}`)
}
for (const label of ['源码', '证据详情']) {
  if (!reviewPage.includes(label) && !taskMessage.includes(label)) throw new Error(`正式任务复盘缺少消息操作：${label}`)
}
if (!reviewPage.includes('className="round-nav-filters"') || !reviewPage.includes('className="round-nav-actions"')) throw new Error('任务复盘必须保留轮次筛选组和操作组')
for (const semanticClass of ['round-nav-from-start', 'round-nav-latest', 'round-nav-live']) {
  if (!reviewPage.includes(`className="${semanticClass}"`)) throw new Error(`任务复盘缺少稳定语义类：${semanticClass}`)
}
if (/\{[^{}]*&&\s*<button[^>]*className="round-nav-(?:from-start|latest)"/s.test(reviewPage)) throw new Error('从头查看和跳到最新必须常驻渲染，无意义状态使用 disabled')

const selectSessionBody = clientModel.match(/async selectReviewSession\(id: string\): Promise<void> \{([\s\S]*?)\r?\n  \}\r?\n\r?\n  async refreshUsage/)?.[1] ?? ''
if (!selectSessionBody.includes("this.api.reviewDetail(id, { direction: 'backward', limit: REVIEW_DETAIL_PAGE_SIZE })")) throw new Error('默认选择会话必须请求 backward 最新窗口')
const fromStartBody = clientModel.match(/async showReviewFromStart\(\): Promise<void> \{([\s\S]*?)\r?\n  \}\r?\n\r?\n  acknowledgeReviewNewData/)?.[1] ?? ''
if (!fromStartBody.includes("direction: 'forward'")) throw new Error('从头查看必须显式请求 forward 窗口')
if (!reviewPage.includes("detail.page.direction !== 'backward'") || !reviewPage.includes('pane.scrollTop = pane.scrollHeight') || !reviewPage.includes('followingTailRef.current = true')) throw new Error('默认最新窗口必须渲染后定位到底部并进入跟随状态')
if (!reviewPage.includes('pane.scrollHeight - pane.scrollTop - pane.clientHeight < 180')) throw new Error('阅读历史时不得抢滚动位置')

if (!reviewPage.includes('<Drawer') || !reviewPage.includes('className="review-inspector-overlay"') || !reviewPage.includes('onClose={onClose}')) throw new Error('事件详情必须消费统一 Drawer')
if (reviewPage.includes("document.addEventListener('keydown'") || reviewPage.includes('className="inspector-panel"')) throw new Error('事件详情不得恢复页面自建键盘/抽屉生命周期')
if (mainSource.includes('installInspectorOutsideDismiss') || mainSource.includes('disposeInspectorOutsideDismiss')) throw new Error('统一 Drawer 已持有外部点击关闭，不得恢复全局 Inspector dismiss')

if (/\.review-page \.round-nav\s*\{[^{}]*display\s*:\s*none/s.test(longCss) || /\.review-page \.round-nav\s*\{[^{}]*visibility\s*:\s*hidden/s.test(longCss)) throw new Error('长会话性能层不得隐藏轮次导航本体')
if (/\.round-nav\s*>\s*button:nth-of-type/.test(longCss) || /\.round-nav[^{}]*nth-(?:child|of-type)/.test(longCss)) throw new Error('长会话性能层不得按按钮序号控制业务表现')
if (/\.round-nav[^\n{]*\[[^\]]*(?:data-|aria-)[^\]]*\][^{}]*\{[^{}]*(?:display|visibility)\s*:/gs.test(longCss)) throw new Error('长会话性能层不得根据业务状态属性隐藏导航')
if (!/\.review-page \.round-nav button\s*\{[^}]*white-space:\s*nowrap/s.test(longCss)) throw new Error('长会话导航所有者必须保证操作单行展示')
if (!longCss.includes('.round-nav-filters') || !longCss.includes('.round-nav-actions')) throw new Error('长会话布局必须基于筛选组/操作组')

if (!mainSource.includes("import './task-detail.css'")) throw new Error('Task Surface 共享正式样式必须在 Web 入口加载')
if (mainSource.includes("task-detail-prototype.css") || mainSource.includes("task-detail-polish.css") || mainSource.includes("task-feedback-polish.css")) throw new Error('正式入口不得恢复 Task Surface 临时覆盖层')
if (taskMessage.includes('task-message-agent-mark') || taskMessage.includes('chat-avatar-agent')) throw new Error('Agent 输出不得恢复头像节点')
if (!taskMessage.includes('{!user && <button') || !taskMessage.includes('<span>源码</span>')) throw new Error('源码切换只属于 Agent Markdown')
if (!/\.task-surface \.task-message-assistant \.markdown-message-actions\s*\{[\s\S]*?position:\s*absolute;/m.test(taskDetailCss)) throw new Error('Agent 源码切换必须悬浮在正文内，不得单独占行')
if (/<details[\s\S]*data-task-tool-group="true"/.test(taskToolGroup)) throw new Error('Tool Group 不得制造独立折叠父层')
if (!reviewPresentation.includes('nativeParentEventId') || !reviewPresentation.includes('parentObservationId') || !reviewPresentation.includes('matches.length !== 1')) throw new Error('Thinking / Tool 层级必须只依据显式父关系')
if (!reviewPage.includes('projectReviewInteractionPresentation(interaction.nodes)') || !reviewPage.includes('nestedTools={entry.tools}')) throw new Error('Review 必须实际使用显式父关系投影')

if (!taskDetailCss.includes('.task-round-summary::after') || !taskDetailCss.includes('max-width: 56px') || /\.task-round-summary::before\s*\{[^}]*background:/s.test(taskDetailCss)) throw new Error('轮次标题只允许短右分隔线，不得恢复左右贯穿式分割线')
if (!taskDetailCss.includes('.task-header-status') || !taskDetailCss.includes('pointer-events: none') || !taskDetailCss.includes('.task-header-actions button')) throw new Error('任务详情头必须明确区分状态与可点击操作')
if (!reviewCss.includes('.evidence-inline') || !reviewCss.includes('.review-inspector-overlay') || /\.inspector-panel\b/.test(reviewCss)) throw new Error('Review 页面所有者必须保留证据/Inspector 业务内容，抽屉外壳统一由 Drawer 持有')

console.log('任务复盘交互契约检查通过：默认最新窗口、历史阅读不抢滚动、统一 Drawer、单一短分隔线、显式 Thinking/Tool 层级、Agent 源码入口悬浮与 Task Surface 单一样式所有权均已锁定。')
