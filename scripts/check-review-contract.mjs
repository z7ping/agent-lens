import { readFileSync } from 'node:fs'

const mainSource = readFileSync('packages/web/src/main.tsx', 'utf8')
const clientModel = readFileSync('packages/web/src/client/model-review.ts', 'utf8')
const reviewPage = [ readFileSync('packages/web/src/features/review-session-format.ts', 'utf8'),
  readFileSync('packages/web/src/features/ReviewEvidenceInspector.tsx', 'utf8'),
  readFileSync('packages/web/src/features/ReviewRoundPresentation.tsx', 'utf8'),
  readFileSync('packages/web/src/features/review-reader-position.ts', 'utf8'),
  readFileSync('packages/web/src/features/use-review-session.ts', 'utf8'),
  readFileSync('packages/web/src/features/ReviewPage.tsx', 'utf8') ].join('\n')
const taskSurface = readFileSync('packages/web/src/features/TaskSurface.tsx', 'utf8')
const taskHeader = readFileSync('packages/web/src/features/TaskHeader.tsx', 'utf8')
const taskMessage = readFileSync('packages/web/src/features/TaskMessage.tsx', 'utf8')
const taskToolGroup = readFileSync('packages/web/src/features/TaskToolGroup.tsx', 'utf8')
const reviewPresentation = readFileSync('packages/web/src/features/review-interaction-presentation.ts', 'utf8')
const taskDetailCss = readFileSync('packages/web/src/task-detail.css', 'utf8')
const taskSessionCss = readFileSync('packages/web/src/task-session-view.css', 'utf8')
const reviewCss = readFileSync('packages/web/src/review.css', 'utf8')
const longCss = readFileSync('packages/web/src/review-long-session.css', 'utf8')
const officialZhCn = `${readFileSync('packages/web/src/i18n/official-zh-CN.ts', 'utf8')}\n${readFileSync('packages/web/src/i18n/zh-CN/review.ts', 'utf8')}\n${readFileSync('packages/web/src/i18n/zh-CN/task.ts', 'utf8')}`

if (!reviewPage.includes("t('local.roundNav.newRecords')") || !officialZhCn.includes("newRecords: '有新记录'")) {
  throw new Error('正式任务复盘缺少国际化新记录提示')
}
for (const [source, locale] of [
  [taskMessage, "t('message.viewMarkdownSource')"],
  [reviewPage, "t('local.evidence.evidenceDetail'"],
]) {
  if (!source.includes(locale)) throw new Error(`正式任务复盘缺少国际化消息操作：${locale}`)
}
for (const label of ["viewMarkdownSource: '查看 Markdown 源码'", "returnRendered: '返回渲染结果'", "evidenceDetail: '证据详情 · {{count}}'"]) {
  if (!officialZhCn.includes(label)) throw new Error(`简体中文任务复盘缺少消息操作文案：${label}`)
}
if (!reviewPage.includes('className="round-nav-filters"') || !reviewPage.includes('className="round-nav-actions"')) throw new Error('任务复盘必须保留轮次筛选组和操作组')
if (!reviewPage.includes('className="round-nav-live"')) throw new Error('任务复盘必须保留新记录快捷入口')
for (const marker of [
  'boundaryNavigation={detail ? {',
  'startDisabled: roundFilterLoading || atStart',
  'endDisabled: roundFilterLoading',
  'onStart: showFromStart',
  'onEnd: jumpToLatest',
]) {
  if (!reviewPage.includes(marker)) throw new Error(`Review 必须向 TaskSurface 提供统一边界导航行为：${marker}`)
}
for (const marker of [
  'export interface TaskBoundaryNavigation',
  'className="task-boundary-nav"',
  "aria-label={t('surface.boundaryNavigation')}",
  "title={t('surface.jumpStart')}",
  "aria-label={t('surface.jumpStart')}",
  'className="task-boundary-latest"',
  "title={t('surface.jumpLatest')}",
  'onClick={() => void resolvedBoundaryNavigation.onStart()}',
  'onClick={() => void resolvedBoundaryNavigation.onEnd()}',
]) {
  if (!taskSurface.includes(marker)) throw new Error(`TaskSurface 缺少统一边界导航契约：${marker}`)
}
for (const retiredClass of ['round-nav-from-start', 'round-nav-latest']) {
  if (reviewPage.includes(retiredClass)) throw new Error(`Review 不得恢复已迁移到 TaskSurface 的私有边界按钮：${retiredClass}`)
}

const selectSessionBody = clientModel.match(/async selectReviewSession\(id: string\): Promise<void> \{([\s\S]*?)\r?\n  \}/)?.[1] ?? ''
if (!/this\.api\.reviewDetail\(id, \{\s*direction: 'backward',\s*limit: REVIEW_DETAIL_PAGE_SIZE,\s*process: 'summary'(?:,\s*signal: controller\.signal)?\s*\}\)/.test(selectSessionBody)) throw new Error('默认选择会话必须请求 backward 最新窗口，并只读取 Process Summary')
if (!selectSessionBody.includes('this.reviewSelectionAbort?.abort()') || !selectSessionBody.includes('signal: controller.signal')) throw new Error('切换会话必须中止旧会话详情请求')
const fromStartBody = clientModel.match(/async showReviewFromStart\(\): Promise<void> \{([\s\S]*?)\r?\n  \}\r?\n\r?\n  acknowledgeReviewNewData/)?.[1] ?? ''
if (!fromStartBody.includes("direction: 'forward'")) throw new Error('从头查看必须显式请求 forward 窗口')
if (!fromStartBody.includes("process: 'summary'")) throw new Error('从头查看首屏不得回退为完整 Process 读取')
for (const marker of [
  "direction: 'backward', limit: REVIEW_DETAIL_PAGE_SIZE, process: 'summary'",
  "filter, limit: REVIEW_DETAIL_PAGE_SIZE, process: 'summary'",
  "{ ordinal, process: 'summary' }",
]) {
  if (!clientModel.includes(marker)) throw new Error(`Review 导航必须保持 Process Summary 首屏契约：${marker}`)
}
if (!reviewPage.includes("detail.page.direction !== 'backward'") || !reviewPage.includes('pane.scrollTop = pane.scrollHeight') || !reviewPage.includes('followingTailRef.current = true')) throw new Error('默认最新窗口必须渲染后定位到底部并进入跟随状态')
if (!reviewPage.includes('pane.scrollHeight - pane.scrollTop - pane.clientHeight < 180')) throw new Error('阅读历史时不得抢滚动位置')
if (!reviewPage.includes("detail.page.direction !== 'backward'") || !reviewPage.includes('void loadOlder().finally')) throw new Error('Review 更早轮次必须由滚动 sentinel 自动加载')
if (!reviewPage.includes('detailAutoLoadBaselineRef.current = userRevision')) throw new Error('Review 每次向前加载后必须重新等待新的用户滚动意图')
if (reviewPage.includes("t('local.roundNav.loadOlder')")) throw new Error('Review 不得恢复“加载更早”分页按钮；失败时只保留重试')

if (!reviewPage.includes('className="review-reader-pane"') || !reviewPage.includes('className="review-reader"')) throw new Error('Review 必须保留分页/滚动行为钩子，由 TaskSurface 归一为 Session 槽位')
if (!taskSurface.includes("'review-reader-pane'") || !taskSurface.includes("'live-task-reader'")) throw new Error('TaskSurface 必须识别 Review / 通用 Live Reader 行为钩子')
if (!taskSurface.includes("'review-reader'") || !taskSurface.includes("'live-task-document'")) throw new Error('TaskSurface 必须识别 Review / 通用 Live Document 行为钩子')
if (!taskSurface.includes("'task-session-composer-slot'")) throw new Error('TaskSurface 必须识别通用 Live Composer 行为钩子')
if (!taskSurface.includes("withSessionClass(element, 'task-session-reader'") || !taskSurface.includes("withSessionClass(candidate, 'task-session-document')")) throw new Error('TaskSurface 必须将 Review / Live 归一为共享 Reader / Document 槽位')
if (!taskSessionCss.includes('.task-session-view > .task-session-reader') || !taskSessionCss.includes('.task-session-view .task-session-document')) throw new Error('统一 Session 样式必须只基于共享 Reader / Document 槽位')
if (taskSessionCss.includes('.review-reader') || taskSessionCss.includes('.pi-live-document')) throw new Error('统一 Session 样式不得再依赖 Review / Pi 页面私有正文类')

if (taskHeader.includes('.task-surface-review') || taskHeader.includes('.review-reader')) throw new Error('共享 TaskHeader 不得依赖 Review 页面类名或 DOM')
if (!taskHeader.includes('.task-session-view[data-task-session-interactive="false"]')) throw new Error('只读会话尾部操作必须依据统一 Session 状态定位')
if (!taskHeader.includes("child.classList.contains('task-session-reader')") || !taskHeader.includes("child.classList.contains('task-session-document')")) throw new Error('只读会话尾部操作必须通过统一 Session Reader / Document 槽位定位正文')
if (!taskHeader.includes("className = 'task-session-tail-actions-host'") || !taskHeader.includes('documentRoot.append(host)')) throw new Error('继续/分叉操作必须保留统一 Session 正文尾部挂载点')
if (!taskHeader.includes('sessionTailHost?.parentElement === documentRoot')) throw new Error('切换同能力会话时必须核对尾部挂载点仍属于当前正文')
if (/\},\s*\[primaryActions\.length\]\)/.test(taskHeader)) throw new Error('尾部挂载点不得只按按钮数量更新，否则同能力会话切换会遗留旧 Host')
if (!longCss.includes('.task-session-tail-actions-host')) throw new Error('Review 长会话层必须只补充统一 Session 尾部挂载点间距')

if (!reviewPage.includes('<Drawer') || !reviewPage.includes('className="review-inspector-overlay"') || !reviewPage.includes('onClose={onClose}')) throw new Error('事件详情必须消费统一 Drawer')
if (reviewPage.includes("document.addEventListener('keydown'") || reviewPage.includes('className="inspector-panel"')) throw new Error('事件详情不得恢复页面自建键盘/抽屉生命周期')
if (mainSource.includes('installInspectorOutsideDismiss') || mainSource.includes('disposeInspectorOutsideDismiss')) throw new Error('统一 Drawer 已持有外部点击关闭，不得恢复全局 Inspector dismiss')

if (/\.review-page \.round-nav\s*\{[^{}]*display\s*:\s*none/s.test(longCss) || /\.review-page \.round-nav\s*\{[^{}]*visibility\s*:\s*hidden/s.test(longCss)) throw new Error('长会话性能层不得隐藏轮次导航本体')
if (/\.round-nav\s*>\s*button:nth-of-type/.test(longCss) || /\.round-nav[^{}]*nth-(?:child|of-type)/.test(longCss)) throw new Error('长会话性能层不得按按钮序号控制业务表现')
if (/\.round-nav[^\n{]*\[[^\]]*(?:data-|aria-)[^\]]*\][^{}]*\{[^{}]*(?:display|visibility)\s*:/gs.test(longCss)) throw new Error('长会话性能层不得根据业务状态属性隐藏导航')
if (!/\.review-page \.round-nav button\s*\{[^}]*white-space:\s*nowrap/s.test(longCss)) throw new Error('长会话导航所有者必须保证操作单行展示')
if (!longCss.includes('.round-nav-filters') || !longCss.includes('.round-nav-actions')) throw new Error('长会话布局必须基于筛选组/操作组')

if (!mainSource.includes("import './task-detail.css'") || !mainSource.includes("import './task-session-view.css'")) throw new Error('Task Surface 共享组件与 Session 样式必须在 Web 入口加载')
if (mainSource.includes("task-detail-prototype.css") || mainSource.includes("task-detail-polish.css") || mainSource.includes("task-feedback-polish.css")) throw new Error('正式入口不得恢复 Task Surface 临时覆盖层')
if (taskMessage.includes('task-message-agent-mark') || taskMessage.includes('chat-avatar-agent')) throw new Error('Agent 输出不得恢复头像节点')
if (!taskMessage.includes('!user && showContentActions && <IconButton')
  || !taskMessage.includes("t('message.viewMarkdownSource')")
  || !taskMessage.includes("t('message.returnRendered')")
  || !taskMessage.includes("onClick={() => setView(value => value === 'rendered' ? 'source' : 'rendered')}")) {
  throw new Error('源码切换必须是共享 TaskMessage 的 Agent 专属操作，保持国际化及渲染/源码双向切换')
}
if (!/\.task-surface \.task-message-assistant \.markdown-message-actions\s*\{[\s\S]*?position:\s*static;/m.test(taskDetailCss)
  || !taskMessage.includes('className="task-message-copy-action"')
  || !taskMessage.includes('className="task-message-source-action"')) {
  throw new Error('复制/源码操作必须共用 TaskMessage 正文内同一操作栏，不得恢复独立悬浮层')
}
if (/<details[\s\S]*data-task-tool-group="true"/.test(taskToolGroup)) throw new Error('Tool Group 不得制造独立折叠父层')
// The old gate compared a single tool-group push expression. It rejected a
// behavior-preserving segmentation of consecutive tools by *explicit* native
// reasoning parent. Keep hard checks for source order and evidence boundaries.
if (!reviewPresentation.includes("if (node.type === 'tool')")
  || !reviewPresentation.includes('tools.push(node)')
  || !reviewPresentation.includes('for (const tool of tools)')
  || !reviewPresentation.includes('segment.push(tool)')
  || !reviewPresentation.includes("result.push({ type: 'tool-group', items: segment")
  || !reviewPresentation.includes("node.role === 'reasoning') result.push({ type: 'reasoning', node, tools: [] })")
  || !reviewPresentation.includes('parentIds = [tool.nativeParentEventId, tool.parentObservationId]')
  || !reviewPresentation.includes('node.sourceId === tool.sourceId')
  || !reviewPresentation.includes('matches.length === 1')
  || !reviewPresentation.includes('parentReasoningId ? { parentReasoningId } : {}'))
  throw new Error('Thinking / Tool 必须遵守 Canonical 顺序：只允许唯一、同源、显式父级证据，不得猜测或重排')
if (!reviewPage.includes('projectReviewInteractionPresentation(effectiveInteraction.nodes)')) throw new Error('Review 必须用当前 Summary/Detail 对应的有效 Interaction 执行统一 Turn 投影')

if (!taskDetailCss.includes('.task-round-summary::after') || !taskDetailCss.includes('max-width: 56px') || /\.task-round-summary::before\s*\{[^}]*background:/s.test(taskDetailCss)) throw new Error('轮次标题只允许短右分隔线，不得恢复左右贯穿式分割线')
if (!taskDetailCss.includes('.task-header-status') || !taskDetailCss.includes('pointer-events: none') || !taskDetailCss.includes('.task-header-actions button')) throw new Error('任务详情头必须明确区分状态与可点击操作')
if (!reviewCss.includes('.evidence-inline') || !reviewCss.includes('.review-inspector-overlay') || /\.inspector-panel\b/.test(reviewCss)) throw new Error('Review 页面所有者必须保留证据/Inspector 业务内容，抽屉外壳统一由 Drawer 持有')

console.log('任务复盘交互契约检查通过：统一 Session Reader / Document、统一边界导航、默认最新窗口、历史阅读不抢滚动、统一 Drawer、尾部继续操作、轮次导航与 Thinking / Tool 原序语义均已锁定。')
