import { existsSync, readFileSync } from 'node:fs'

const root = 'packages/web/src'
const p = name => `${root}/${name}`
const files = {
  main: p('main.tsx'), styles: p('styles.css'), tokens: p('tokens.css'), theme: p('theme.css'), typography: p('typography.css'),
  readability: p('readability.css'), semantic: p('semantic-colors.css'), shell: p('shell.css'), shellResponsive: p('shell-responsive.css'),
  states: p('states.css'), tools: p('tools.css'), insights: p('insights.css'), agents: p('agents.css'), agentResponsive: p('agent-insights-responsive.css'),
  backup: p('backup.css'), backupResponsive: p('backup-responsive.css'), review: p('review.css'), reviewLong: p('review-long-session.css'),
  pi: p('pi-live.css'), taskCenter: p('task-center.css'), taskDetail: p('task-detail.css'),
}

const retired = [
  'review-balanced.css', 'review-balanced-runtime.ts', 'review-polish.css', 'review-reference.css', 'review-message-actions.css',
  'review-v2-final.css', 'color-system.css', 'v2-1.css', 'v2-alignment.css', 'p0-polish.css', 'prototype.css',
  'desktop-responsive.css', 'task-execution.css', 'task-detail-prototype.css', 'task-detail-polish.css', 'task-feedback-polish.css',
  'features/task-header.css',
].map(p)
for (const file of retired) if (existsSync(file)) throw new Error(`已退役表现层不应重新出现：${file}`)

const main = readFileSync(files.main, 'utf8')
const imports = [...main.matchAll(/import\s+['\"](.+?\.css)['\"]/g)].map(match => match[1])
const at = value => imports.indexOf(value)
for (const required of [
  './styles.css', './tokens.css', './theme.css', './typography.css', './readability.css', './semantic-colors.css',
  './shell.css', './shell-responsive.css', './states.css', './agents.css', './agent-insights-responsive.css', './tools.css', './insights.css',
  './review.css', './review-long-session.css', './backup.css', './backup-responsive.css', './pi-live.css', './task-center.css', './task-detail.css',
]) {
  if (at(required) < 0) throw new Error(`正式 Web 缺少样式入口：${required}`)
}
if (!(at('./styles.css') < at('./tokens.css')
  && at('./tokens.css') < at('./semantic-colors.css')
  && at('./semantic-colors.css') < at('./shell.css')
  && at('./agents.css') < at('./agent-insights-responsive.css')
  && at('./review.css') + 1 === at('./review-long-session.css')
  && at('./backup.css') < at('./backup-responsive.css')
  && at('./task-center.css') < at('./task-detail.css'))) {
  throw new Error('正式样式加载顺序不符合“基础/Token → 壳层 → 页面所有者 → Task Surface 共享组件”契约')
}

const read = key => readFileSync(files[key], 'utf8')
const css = Object.fromEntries(Object.keys(files).filter(key => key !== 'main').map(key => [key, read(key)]))
if (!/--font-size-xs:\s*12px\s*;/.test(css.typography)) throw new Error('正式字体系统最小语义字号必须保持 12px')
function pixelFonts(source) {
  return [...source.matchAll(/\{([^{}]*)\}/gs)].flatMap(block => [...block[1].matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px\b/g)]).map(match => Number(match[1]))
}
for (const key of ['styles', 'theme', 'typography', 'readability', 'semantic', 'shell', 'shellResponsive', 'states', 'tools', 'insights', 'agents', 'agentResponsive', 'backup', 'backupResponsive', 'review', 'reviewLong', 'taskCenter', 'taskDetail']) {
  const tooSmall = pixelFonts(css[key]).filter(value => value > 0 && value < 12)
  if (tooSmall.length) throw new Error(`${files[key]} 出现小于 12px 的有效字号：${[...new Set(tooSmall)].join(', ')}px`)
}
for (const key of ['theme', 'semantic', 'shell', 'shellResponsive', 'states', 'tools', 'insights', 'agents', 'agentResponsive', 'backup', 'backupResponsive', 'review', 'reviewLong', 'pi', 'taskCenter', 'taskDetail']) {
  if (/!important\b/.test(css[key])) throw new Error(`${files[key]} 不得用 !important 争夺表现所有权`)
}

if (!css.styles.includes('AgentLens 1.0 全局基础样式')) throw new Error('styles.css 必须保持为全局基础层')
if (/\.app-header\b|\.tool-summary-grid\b|\.agent-card\b|\.review-page\b/.test(css.styles)) throw new Error('styles.css 不得承载一级页面专属规则')
if (!/\.btn\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?height:\s*30px;[\s\S]*?font-size:\s*12px;[\s\S]*?white-space:\s*nowrap;/m.test(css.styles)) {
  throw new Error('共享按钮必须保持 inline-flex / 30px / 12px / 不换行')
}
const duplicated = ['--al-canvas', '--al-surface', '--al-soft', '--al-line', '--al-ink', '--al-accent']
  .filter(token => new RegExp(`${token.replaceAll('-', '\\-')}\\s*:`).test(css.theme))
if (duplicated.length) throw new Error(`theme.css 不得重复声明基础 Token：${duplicated.join(', ')}`)

if (!/\.app-header\s*\{[\s\S]*?backdrop-filter\s*:\s*none/m.test(css.shell)) throw new Error('Header 必须由 shell.css 关闭背景模糊')
if (!css.shell.includes('.runtime-status-popover') || !css.shell.includes('.runtime-status-grid') || !css.shell.includes('.runtime-status-wide')) throw new Error('顶部运行状态事实 Popover 能力缺失')
if (!/\.workspace-toolbar\s*\{[\s\S]*?height:\s*50px;[\s\S]*?min-height:\s*50px;/m.test(css.shell)) throw new Error('工作区工具栏必须保持 50px 基线')
if (!/\.filter\s*\{[\s\S]*?height:\s*34px;[\s\S]*?font-size:\s*13px;/m.test(css.shell)) throw new Error('筛选控件必须保持 34px / 13px')
if (!/\.scope-chip\s*\{[\s\S]*?height:\s*32px;[\s\S]*?font-size:\s*13px;/m.test(css.shell)) throw new Error('Agent 筛选 Chip 必须保持 32px / 13px')
for (const breakpoint of ['1199.98px', '991.98px', '767.98px', '575.98px']) if (!css.shellResponsive.includes(breakpoint)) throw new Error(`shell-responsive.css 缺少断点 ${breakpoint}`)
if (!/@media \(max-width: 575\.98px\)[\s\S]*?\.app-header \.brand\s*\{[\s\S]*?display:\s*flex/m.test(css.shellResponsive)) throw new Error('xs 窄窗口必须保留 Logo')
for (const legacy of ['1080px', '1100px', '900px', '820px', '760px', '560px']) {
  const re = new RegExp(`@media\\s*\\([^)]*(?:max-width|min-width)\\s*:\\s*${legacy.replace('.', '\\.')}\\b`)
  if (re.test(css.shellResponsive) || re.test(css.states)) throw new Error(`壳层/状态层不得恢复一次性断点：${legacy}`)
}

if (!css.tools.includes('工具分析正式样式') || !css.tools.includes('.tool-summary-grid') || !css.tools.includes('.tool-table-card') || !css.tools.includes('.tool-attention-row') || !css.tools.includes('.tool-session-link') || !css.tools.includes('.tool-kind-svg')) throw new Error('工具分析关键能力样式缺失')
if (!css.insights.includes('使用洞察正式样式') || !css.insights.includes('.insight-kpi-grid') || !css.insights.includes('.insight-trend') || !css.insights.includes('.insight-pattern-list')) throw new Error('使用洞察关键能力样式缺失')
if (!css.agents.includes('智能体概览正式样式') || !css.agents.includes(".agent-card[data-source='hermes']") || !css.agents.includes(".agent-card[data-source='opencode']") || !css.agents.includes('.frequent-asset-row') || !css.agents.includes('.skill-funnel')) throw new Error('智能体概览关键能力样式缺失')
if (!css.agentResponsive.includes('@media (min-width: 1400px)') || !css.agentResponsive.includes('.agents-responsive-shell') || !css.agentResponsive.includes('.agent-insights-rail')) throw new Error('Agents xxl 响应式必须由 agent-insights-responsive.css 持有')
if (!css.backup.includes('AgentLens 1.0 资产备份正式样式') || !css.backup.includes('正在扫描资产备份范围') || !css.backup.includes('.snapshot-builder') || !css.backup.includes('.preview-summary')) throw new Error('资产备份关键能力样式缺失')
if (!css.backupResponsive.includes('1280×800 / 1366×768') || !css.backupResponsive.includes('@media (min-width: 1200px) and (max-width: 1399.98px)') || !css.backupResponsive.includes('white-space: nowrap') || !css.backupResponsive.includes('grid-column: 1 / -1')) throw new Error('资产备份 xl 主桌面响应式契约缺失')

if (!css.review.includes('AgentLens 1.0 Review 页面所有者') || !css.review.includes('.evidence-inline') || !css.review.includes('.raw-event-group') || !css.review.includes('.pi-session-tree') || !css.review.includes('.inspector-panel')) throw new Error('review.css 必须只持有 Review 页面/证据/Inspector 能力')
if (!css.reviewLong.includes('.round-nav') || !css.reviewLong.includes('.turn-rail') || !css.reviewLong.includes('.turn-tick') || !css.reviewLong.includes('.virtual-round-shell')) throw new Error('review-long-session.css 必须持有长会话/轮次导航能力')
if (!css.pi.includes('Pi Live 专属样式所有者') || !css.pi.includes('.pi-live-composer') || !css.pi.includes('.pi-live-queue') || !/\.pi-live-compose-hint[\s\S]*?position:\s*absolute/m.test(css.pi)) throw new Error('pi-live.css 必须持有 Runtime/Composer/Queue，且快捷提示不得参与布局高度')
if (!css.taskCenter.includes('Task Center 页面壳层唯一所有者') || !css.taskCenter.includes('.task-center-rail') || !css.taskCenter.includes('.task-center-main') || !css.taskCenter.includes('左右滚动根完全隔离')) throw new Error('task-center.css 必须持有 Rail/详情壳层和独立滚动')
if (!css.taskDetail.includes('Task Surface 共享详情组件的唯一样式所有者') || !css.taskDetail.includes('.task-header') || !css.taskDetail.includes('.task-round') || !css.taskDetail.includes('.task-message-bubble-user') || !css.taskDetail.includes('background: var(--al-user-bubble)') || !css.taskDetail.includes('.task-message-assistant') || !css.taskDetail.includes('.task-thinking') || !css.taskDetail.includes('.task-tool-row') || !css.taskDetail.includes('.task-event-row')) throw new Error('task-detail.css 必须完整持有 Task Surface 共享组件')

function block(source, selector) {
  const start = source.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`缺少设计令牌块：${selector}`)
  const body = source.indexOf('{', start) + 1
  return source.slice(body, source.indexOf('}', body))
}
const vars = source => new Map([...source.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]))
function rgb(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`对比度只接受 6 位 HEX：${hex}`)
  return [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
}
function luminance(hex) {
  const [r, g, b] = rgb(hex).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
  return .2126 * r + .7152 * g + .0722 * b
}
function contrast(fg, bg) { const a = luminance(fg); const b = luminance(bg); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05) }
const light = vars(block(css.tokens, ':root'))
const dark = vars(block(css.tokens, ":root[data-theme='dark']"))
for (const [label, fg, bg] of [
  ['浅色正文/画布', light.get('--al-ink'), light.get('--al-canvas')], ['浅色次要文字/软底', light.get('--al-muted'), light.get('--al-soft')],
  ['浅色用户气泡', light.get('--al-user-bubble-text'), light.get('--al-user-bubble')], ['暗色正文/画布', dark.get('--al-ink'), dark.get('--al-canvas')],
  ['暗色次要文字/软底', dark.get('--al-muted'), dark.get('--al-soft')], ['暗色用户气泡', dark.get('--al-user-bubble-text'), dark.get('--al-user-bubble')],
]) {
  if (!fg || !bg) throw new Error(`${label} 缺少 Token`)
  const ratio = contrast(fg, bg)
  if (ratio < 4.5) throw new Error(`${label} 对比度不足：${ratio.toFixed(2)}`)
}

console.log('AgentLens 正式 Web 表现检查通过：单一样式所有权、响应式、字号、对比度与关键页面能力均已锁定。')
