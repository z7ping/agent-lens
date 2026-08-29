import { existsSync, readFileSync } from 'node:fs'

const backup = readFileSync('packages/web/src/features/BackupPage.tsx', 'utf8')
const agents = readFileSync('packages/web/src/features/AgentsPage.tsx', 'utf8')
const review = readFileSync('packages/web/src/features/ReviewPage.tsx', 'utf8')
const virtualRound = readFileSync('packages/web/src/components/VirtualRoundMount.tsx', 'utf8')
const diagnostics = readFileSync('packages/web/src/components/AgentInsightsRail.tsx', 'utf8')
const responsive = readFileSync('packages/web/src/desktop-responsive.css', 'utf8')
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

if (backup.includes('scope-chip')) throw new Error('资产备份不得同时在顶部工具栏和快照构建器重复选择智能体')
for (const required of ['本地真实数据', '刷新扫描', '导入备份包', '创建快照']) {
  if (!backup.includes(required)) throw new Error(`资产备份工具栏缺少核心状态或操作：${required}`)
}

for (const required of ['className="agent-source-nav-head"', '刷新智能体概览']) {
  if (!agents.includes(required)) throw new Error(`智能体来源列表缺少就地刷新入口：${required}`)
}
if (agents.includes('<AgentScope')) throw new Error('智能体概览不得同时保留顶部来源切换与左侧来源列表')

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
  'md 768 / lg 992 / xl 1200 / xxl 1400',
  '.agents-responsive-shell',
  '.agent-insights-rail',
  '@media (min-width: 1400px)',
  'position: sticky;',
]) {
  if (!responsive.includes(required)) throw new Error(`智能体洞察缺少桌面响应式约束：${required}`)
}

if (existsSync('packages/web/src/agent-diagnostics.css') || main.includes("'./agent-diagnostics.css'")) {
  throw new Error('旧采集诊断 Dock 不得重新进入正式 Web 渲染/样式链')
}

console.log('核心交互收口检查通过：快照结果可见、跨会话阅读位置可恢复、智能体诊断与覆盖洞察已收口')
