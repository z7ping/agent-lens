import { readFileSync } from 'node:fs'

const mainSource = readFileSync('packages/web/src/main.tsx', 'utf8')
const inspectorDismiss = readFileSync('packages/web/src/client/inspector-dismiss.ts', 'utf8')
const clientModel = readFileSync('packages/web/src/client/model.ts', 'utf8')
const reviewPage = readFileSync('packages/web/src/features/ReviewPage.tsx', 'utf8')
const taskMessage = readFileSync('packages/web/src/features/TaskMessage.tsx', 'utf8')
const taskToolGroup = readFileSync('packages/web/src/features/TaskToolGroup.tsx', 'utf8')
const reviewPresentation = readFileSync('packages/web/src/features/review-interaction-presentation.ts', 'utf8')
const taskDetailCss = readFileSync('packages/web/src/task-detail-prototype.css', 'utf8')
const reviewCss = readFileSync('packages/web/src/review.css', 'utf8')
const longCss = readFileSync('packages/web/src/review-long-session.css', 'utf8')

for (const label of ['从头查看', '跳到最新', '有新记录']) {
  if (!reviewPage.includes(label)) throw new Error(`正式任务复盘缺少关键长会话操作：${label}`)
}
for (const label of ['源码', '证据详情']) {
  if (!reviewPage.includes(label) && !taskMessage.includes(label)) throw new Error(`正式任务复盘缺少消息操作：${label}`)
}

if (!reviewPage.includes('className="round-nav-filters"')
  || !reviewPage.includes('className="round-nav-actions"')) {
  throw new Error('正式任务复盘必须使用明确的轮次筛选组和操作组，禁止退回平铺按钮结构')
}
if (!reviewPage.includes('className="round-nav-from-start"')
  || !reviewPage.includes('className="round-nav-latest"')
  || !reviewPage.includes('className="round-nav-live"')) {
  throw new Error('从头查看、跳到最新、有新记录必须使用稳定语义类，不能依赖按钮序号')
}
if (/\{[^{}]*&&\s*<button[^>]*className="round-nav-(?:from-start|latest)"/s.test(reviewPage)) {
  throw new Error('从头查看和跳到最新必须常驻渲染；无意义状态使用 disabled，不得条件移除')
}

const selectSessionBody = clientModel.match(/async selectReviewSession\(id: string\): Promise<void> \{([\s\S]*?)\r?\n  \}\r?\n\r?\n  async refreshUsage/)?.[1] ?? ''
if (!selectSessionBody.includes("this.api.reviewDetail(id, { direction: 'backward', limit: REVIEW_DETAIL_PAGE_SIZE })")) {
  throw new Error('默认选择会话必须直接请求 backward 最新窗口，禁止退回从头加载长会话')
}
const fromStartBody = clientModel.match(/async showReviewFromStart\(\): Promise<void> \{([\s\S]*?)\r?\n  \}\r?\n\r?\n  acknowledgeReviewNewData/)?.[1] ?? ''
if (!fromStartBody.includes("direction: 'forward'")) {
  throw new Error('“从头查看”必须显式请求 forward 窗口，不能复用默认最新窗口语义')
}
if (!reviewPage.includes("detail.page.direction !== 'backward'")
  || !reviewPage.includes('pane.scrollTop = pane.scrollHeight')
  || !reviewPage.includes('followingTailRef.current = true')) {
  throw new Error('默认最新窗口必须在渲染后定位到底部，并进入可自动跟随状态')
}
if (!reviewPage.includes('pane.scrollHeight - pane.scrollTop - pane.clientHeight < 180')) {
  throw new Error('实时更新只能在用户位于底部附近时自动跟随，阅读历史时不得抢滚动位置')
}

if (!mainSource.includes('installInspectorOutsideDismiss')
  || !mainSource.includes('disposeInspectorOutsideDismiss')) {
  throw new Error('任务复盘事件详情抽屉必须安装并释放外部点击关闭行为')
}
if (!inspectorDismiss.includes('.inspector-panel[role="dialog"][aria-modal="true"]')
  || !inspectorDismiss.includes('panel.contains(target)')
  || !inspectorDismiss.includes('button[aria-label="关闭事件详情"]')) {
  throw new Error('事件详情抽屉必须支持点击抽屉外关闭，并保证抽屉内点击不触发关闭')
}

if (/\.round-nav[^{}]*\{[^{}]*display\s*:\s*none/gs.test(longCss)
  || /\.round-nav[^,{]*[^{}]*\{[^{}]*visibility\s*:\s*hidden/gs.test(longCss)) {
  throw new Error('长会话性能层不得隐藏任务复盘导航或业务操作')
}
if (/\.round-nav\s*>\s*button:nth-of-type/.test(longCss)
  || /\.round-nav[^{}]*nth-(?:child|of-type)/.test(longCss)) {
  throw new Error('长会话性能层不得按按钮序号修改业务操作表现；请使用语义组和语义类')
}
if (/\.round-nav[^\n{]*\[[^\]]*(?:data-|aria-)[^\]]*\][^{}]*\{[^{}]*(?:display|visibility)\s*:/gs.test(longCss)) {
  throw new Error('长会话性能层不得根据业务状态属性控制导航可见性')
}

if (!/\.round-nav\s+button\s*\{[^}]*white-space:\s*nowrap/s.test(reviewCss)) {
  throw new Error('任务复盘正式所有者必须保证长会话操作单行展示')
}
if (!longCss.includes('.round-nav-filters') || !longCss.includes('.round-nav-actions')) {
  throw new Error('长会话布局必须基于筛选组/操作组，不得回退到按钮序号布局')
}

if (!mainSource.includes("import './task-detail-prototype.css'")) {
  throw new Error('任务详情高保真收口样式必须在正式 Web 入口加载')
}
if (taskMessage.includes('task-message-agent-mark') || taskMessage.includes('chat-avatar-agent')) {
  throw new Error('任务详情不得恢复 AI 图标；Agent 输出应保持连续文档流')
}
if (!taskMessage.includes('{!user && <button') || !taskMessage.includes('<span>源码</span>')) {
  throw new Error('源码切换只属于 Agent Markdown，用户消息不得生成源码入口')
}
if (!/\.message-row\.agent \.markdown-message-actions\s*\{[\s\S]*?position:\s*absolute;/m.test(taskDetailCss)) {
  throw new Error('Agent 源码切换必须悬浮在正文内，不得单独占一行')
}
if (/<details[\s\S]*data-task-tool-group="true"/.test(taskToolGroup)) {
  throw new Error('Tool Group 不得制造“执行过程 / 工具执行”独立折叠父层')
}
if (!reviewPresentation.includes('nativeParentEventId')
  || !reviewPresentation.includes('parentObservationId')
  || !reviewPresentation.includes('matches.length !== 1')) {
  throw new Error('Thinking / Tool 层级必须只依据显式父关系，禁止按相邻位置猜测')
}
if (!reviewPage.includes('projectReviewInteractionPresentation(interaction.nodes)')
  || !reviewPage.includes('nestedTools={entry.tools}')) {
  throw new Error('Review 必须实际使用显式父关系投影，而不是仅定义未接入')
}
if (!taskDetailCss.includes('.task-round > summary::before')
  || !taskDetailCss.includes('.task-round > summary::after')) {
  throw new Error('轮次标题必须使用轻分隔线样式，保持“—— 第 n 轮：摘要 ——”语义')
}
if (!taskDetailCss.includes('.task-header-status')
  || !taskDetailCss.includes('pointer-events: none')
  || !taskDetailCss.includes('.task-header-actions button')) {
  throw new Error('任务详情头必须明确区分不可点击状态与可点击操作')
}

console.log('任务复盘正式交互契约检查通过：默认进入最新窗口，历史阅读不抢滚动，轮次轻分隔，Thinking/Tool 仅按显式父关系嵌套，用户无源码入口，Agent 源码入口不占行，状态与按钮语义分离')
