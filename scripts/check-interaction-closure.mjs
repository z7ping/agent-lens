import { existsSync, readFileSync } from 'node:fs'

const backup = readFileSync('packages/web/src/features/BackupPage.tsx', 'utf8')
const review = readFileSync('packages/web/src/features/ReviewPage.tsx', 'utf8')
const virtualRound = readFileSync('packages/web/src/components/VirtualRoundMount.tsx', 'utf8')
const diagnostics = readFileSync('packages/web/src/components/AgentInsightsRail.tsx', 'utf8')
const responsive = readFileSync('packages/web/src/agent-insights-responsive.css', 'utf8')
const main = readFileSync('packages/web/src/main.tsx', 'utf8')

for (const required of [
  "const [success, setSuccess] = useState('')",
  'const result = await api.createBackup',
  'result.snapshot.files.length.toLocaleString()',
  'result.snapshot.excluded.length',
  'role="status"',
  '快照已创建',
]) {
  if (!backup.includes(required)) throw new Error(`资产备份缺少创建结果反馈约束：${required}`)
}

for (const required of [
  'interface ReviewReaderPosition',
  'captureReviewReaderPosition',
  'readerPositionsRef',
  "querySelectorAll<HTMLElement>('.interaction-block[data-interaction-id]')",
  'await model.loadMoreReviewDetail()',
  "current.detail.page.direction !== 'forward'",
  'pane.scrollTop += anchor.getBoundingClientRect().top - paneTop - saved.offset',
]) {
  if (!review.includes(required)) throw new Error(`任务复盘缺少跨会话阅读位置恢复约束：${required}`)
}

for (const required of [
  'data-interaction-id={stableInteractionId || undefined}',
  'className="interaction-block virtual-round-anchor"',
  'data-interaction-id={stableInteractionId}',
]) {
  if (!virtualRound.includes(required)) throw new Error(`虚拟轮次缺少稳定阅读锚点：${required}`)
}

for (const required of [
  'aria-label="智能体洞察"',
  '<h2>采集诊断</h2>',
  '<h2>高频资产覆盖</h2>',
  'const hasIssue = failedStages > 0 || unknownCount > 0',
  'data-state={hasIssue ?',
]) {
  if (!diagnostics.includes(required)) throw new Error(`智能体洞察缺少正式诊断/覆盖约束：${required}`)
}

for (const required of [
  '智能体概览洞察区布局/响应式所有者',
  '.agents-responsive-shell',
  '.agent-insights-rail',
  '@media (min-width: 1400px)',
  '@media (max-width: 1199.98px)',
  '@media (max-width: 991.98px)',
  '@media (max-width: 767.98px)',
  'position: sticky;',
]) {
  if (!responsive.includes(required)) throw new Error(`智能体洞察缺少独立响应式约束：${required}`)
}
if (existsSync('packages/web/src/desktop-responsive.css') || main.includes("'./desktop-responsive.css'")) {
  throw new Error('desktop-responsive.css 已退役；智能体/备份/壳层响应式必须分别由各自所有者持有')
}
if (existsSync('packages/web/src/agent-diagnostics.css') || main.includes("'./agent-diagnostics.css'")) {
  throw new Error('旧采集诊断 Dock 不得重新进入正式 Web 渲染/样式链')
}

console.log('核心交互收口检查通过：快照结果可见、跨会话阅读位置可恢复、智能体诊断与覆盖洞察由独立响应式所有者承载')
