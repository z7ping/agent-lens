import { existsSync, readFileSync } from 'node:fs'

const backup = readFileSync('packages/web/src/features/BackupPage.tsx', 'utf8')
const review = readFileSync('packages/web/src/features/ReviewPage.tsx', 'utf8')
const virtualRound = readFileSync('packages/web/src/components/VirtualRoundMount.tsx', 'utf8')
const diagnostics = readFileSync('packages/web/src/components/AgentInsightsRail.tsx', 'utf8')
const responsive = readFileSync('packages/web/src/agent-insights-responsive.css', 'utf8')
const main = readFileSync('packages/web/src/main.tsx', 'utf8')
const officialZhCn = readFileSync('packages/web/src/i18n/official-zh-CN.ts', 'utf8')

for (const required of [
  "const [success, setSuccess] = useState('')",
  'const result = await api.createBackup',
  'result.snapshot.files.length.toLocaleString(locale)',
  'result.snapshot.excluded.length',
  'role="status"',
  "setSuccess(t('snapshotCreated'",
]) {
  if (!backup.includes(required)) throw new Error(`资产备份缺少创建结果反馈约束：${required}`)
}
if (!officialZhCn.includes("snapshotCreated: '快照已创建：{{files}} 个文件 · {{size}}{{excluded}}'")) {
  throw new Error('简体中文资产备份缺少快照创建结果文案')
}

for (const required of [
  'interface ReviewReaderPosition',
  'captureReviewReaderPosition',
  'readerPositionsRef',
  "querySelectorAll<HTMLElement>('.virtual-round-shell[data-interaction-id]')",
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
  "aria-label={t('insightsRail.aria')}",
  "<h2>{t('insightsRail.diagnosticsTitle')}</h2>",
  "<h2>{t('insightsRail.coverageTitle')}</h2>",
  "const hasIssue = failedStages > 0 || unknownCount > 0 || capacityState === 'approaching' || capacityState === 'exceeded'",
  'data-state={hasIssue ?',
]) {
  if (!diagnostics.includes(required)) throw new Error(`智能体洞察缺少正式诊断/覆盖约束：${required}`)
}
for (const required of [
  "aria: '智能体洞察'",
  "diagnosticsTitle: '采集诊断'",
  "coverageTitle: '高频资产覆盖'",
]) {
  if (!officialZhCn.includes(required)) throw new Error(`简体中文智能体洞察缺少文案：${required}`)
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
