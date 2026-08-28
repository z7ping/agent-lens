import { readFileSync } from 'node:fs'

const mainSource = readFileSync('packages/web/src/main.tsx', 'utf8')
const inspectorDismiss = readFileSync('packages/web/src/client/inspector-dismiss.ts', 'utf8')
const clientModel = readFileSync('packages/web/src/client/model.ts', 'utf8')
const reviewPage = readFileSync('packages/web/src/features/ReviewPage.tsx', 'utf8')
const reviewCss = readFileSync('packages/web/src/review.css', 'utf8')
const longCss = readFileSync('packages/web/src/review-long-session.css', 'utf8')

for (const label of ['从头查看', '跳到最新', '有新记录']) {
  if (!reviewPage.includes(label)) throw new Error(`正式任务复盘缺少关键长会话操作：${label}`)
}
for (const label of ['查看源码', '证据详情']) {
  if (!reviewPage.includes(label)) throw new Error(`正式任务复盘缺少消息操作：${label}`)
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
if (!longCss.includes('消息操作栏必须是一个视觉行')
  || !/\.chat-bubble \.markdown-message-actions,[\s\S]*?\.chat-bubble > \.chat-actions\s*\{[\s\S]*?flex-wrap:\s*nowrap;[\s\S]*?white-space:\s*nowrap;/m.test(longCss)) {
  throw new Error('用户/智能体消息的源码与证据操作必须保持同一视觉行')
}

console.log('任务复盘正式交互契约检查通过：默认进入最新窗口，历史阅读不抢滚动，导航语义固定，抽屉支持外部点击关闭，性能 CSS 不得隐藏业务操作，消息操作保持单行')
