import { existsSync, readFileSync } from 'node:fs'

const mainPath = 'packages/web/src/main.tsx'
const appPath = 'packages/web/src/App.tsx'
const stylesPath = 'packages/web/src/styles.css'
const typographyPath = 'packages/web/src/typography.css'
const tokenPath = 'packages/web/src/tokens.css'
const semanticColorPath = 'packages/web/src/semantic-colors.css'
const shellPath = 'packages/web/src/shell.css'
const toolsPath = 'packages/web/src/tools.css'
const insightsPath = 'packages/web/src/insights.css'
const agentsPath = 'packages/web/src/agents.css'
const backupPath = 'packages/web/src/backup.css'
const reviewPath = 'packages/web/src/review.css'
const reviewLongPath = 'packages/web/src/review-long-session.css'
const mockTokenPath = 'docs/design/mockups/v2/assets/tokens.css'
const mockCurrentPath = 'docs/design/mockups/v2/assets/current.css'
const mockAppPath = 'docs/design/mockups/v2/assets/app.js'
const mockToolsPath = 'docs/design/mockups/v2/tools.html'

const retiredLayers = [
  'packages/web/src/review-balanced.css',
  'packages/web/src/review-balanced-runtime.ts',
  'packages/web/src/review-polish.css',
  'packages/web/src/review-reference.css',
  'packages/web/src/review-message-actions.css',
  'packages/web/src/review-v2-final.css',
  'packages/web/src/color-system.css',
  'packages/web/src/v2-1.css',
  'packages/web/src/v2-alignment.css',
  'packages/web/src/p0-polish.css',
  'packages/web/src/prototype.css',
]

const main = readFileSync(mainPath, 'utf8')
const appSource = readFileSync(appPath, 'utf8')
const cssImports = [...main.matchAll(/import\s+['"](.+?\.css)['"]/g)].map(match => match[1])
const indexOf = path => cssImports.indexOf(path)

for (const path of retiredLayers) {
  if (existsSync(path)) throw new Error(`已退役的表现覆盖层不应重新出现：${path}`)
}

const requiredImports = [
  './styles.css',
  './tokens.css',
  './typography.css',
  './semantic-colors.css',
  './shell.css',
  './backup.css',
  './insights.css',
  './tools.css',
  './agents.css',
  './review.css',
  './review-long-session.css',
]
for (const path of requiredImports) {
  if (indexOf(path) < 0) throw new Error(`正式 Web 缺少样式职责入口：${path}`)
}

if (!(indexOf('./styles.css') < indexOf('./tokens.css')
  && indexOf('./tokens.css') < indexOf('./semantic-colors.css')
  && indexOf('./semantic-colors.css') < indexOf('./shell.css')
  && indexOf('./shell.css') < indexOf('./tools.css')
  && indexOf('./tools.css') < indexOf('./agents.css')
  && indexOf('./agents.css') < indexOf('./review.css')
  && indexOf('./review.css') + 1 === indexOf('./review-long-session.css'))) {
  throw new Error('正式样式顺序必须保持：全局基础 → 设计令牌 → 共享语义色 → 壳层 → 页面所有者；长会话性能层紧随 review.css')
}

if (!existsSync(mockCurrentPath)) throw new Error('当前高保真原型必须保留 assets/current.css')
if (!existsSync(mockAppPath)) throw new Error('当前高保真原型必须保留 assets/app.js')

const typography = readFileSync(typographyPath, 'utf8')
if (!/--font-size-xs:\s*12px\s*;/.test(typography)) {
  throw new Error('正式字体系统的最小语义字号必须保持为 12px')
}

function declaredPixelFontSizes(source) {
  return [...source.matchAll(/\{([^{}]*)\}/gs)]
    .flatMap(blockMatch => [...blockMatch[1].matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px\b/g)])
    .map(match => Number(match[1]))
}

const semanticPresentationPaths = [
  stylesPath,
  typographyPath,
  semanticColorPath,
  shellPath,
  toolsPath,
  insightsPath,
  agentsPath,
  backupPath,
  reviewPath,
  reviewLongPath,
  'packages/web/src/shell-responsive.css',
  mockCurrentPath,
]
for (const path of semanticPresentationPaths) {
  const source = readFileSync(path, 'utf8')
  const tooSmall = declaredPixelFontSizes(source).filter(value => value > 0 && value < 12)
  if (tooSmall.length) {
    throw new Error(`${path} 出现小于 12px 的当前有效字号：${[...new Set(tooSmall)].join(', ')}px`)
  }
}

const stylesSource = readFileSync(stylesPath, 'utf8')
const shellSource = readFileSync(shellPath, 'utf8')
const toolsSource = readFileSync(toolsPath, 'utf8')
const insightsSource = readFileSync(insightsPath, 'utf8')
const agentsSource = readFileSync(agentsPath, 'utf8')
const backupSource = readFileSync(backupPath, 'utf8')
const reviewSource = readFileSync(reviewPath, 'utf8')
const reviewLongSource = readFileSync(reviewLongPath, 'utf8')
const semanticColorSource = readFileSync(semanticColorPath, 'utf8')
const tokenSource = readFileSync(tokenPath, 'utf8')
const mockTokenSource = readFileSync(mockTokenPath, 'utf8')
const mockCurrentSource = readFileSync(mockCurrentPath, 'utf8')
const mockAppSource = readFileSync(mockAppPath, 'utf8')
const mockToolsSource = readFileSync(mockToolsPath, 'utf8')

for (const [name, source] of [
  ['shell.css', shellSource],
  ['semantic-colors.css', semanticColorSource],
  ['tools.css', toolsSource],
  ['insights.css', insightsSource],
  ['agents.css', agentsSource],
  ['backup.css', backupSource],
  ['review.css', reviewSource],
]) {
  if (/!important\b/.test(source)) {
    throw new Error(`${name} 作为正式所有者文件不得依赖 !important 争夺优先级`)
  }
}

if (!stylesSource.includes('AgentLens 1.0 全局基础样式')) {
  throw new Error('styles.css 必须明确保持为全局基础层')
}
if (/\.app-header\b|\.tool-summary-grid\b|\.agent-card\b|\.review-page\b/.test(stylesSource)) {
  throw new Error('styles.css 不得重新承载壳层或一级页面专属规则')
}

if (!/\.app-header\s*\{[\s\S]*?backdrop-filter\s*:\s*none/m.test(shellSource)) {
  throw new Error('正式 Header 必须由 shell.css 关闭背景模糊')
}
if (!shellSource.includes('.status-tip::after') || !shellSource.includes('white-space: pre-line')) {
  throw new Error('正式顶部运行状态提示卡必须由 shell.css 支持多行事实说明')
}
if (!/@media \(max-width: 560px\)[\s\S]*?\.app-header \.brand\s*\{\s*display:\s*flex/m.test(shellSource)) {
  throw new Error('窄窗口必须保留 AgentLens Logo，不能隐藏整个品牌区')
}

if (!toolsSource.includes('工具分析正式样式')) {
  throw new Error('tools.css 必须明确作为工具分析正式样式所有者')
}
if (!toolsSource.includes('.tool-summary-grid')
  || !toolsSource.includes('.tool-table-card')
  || !toolsSource.includes('.tool-attention-row')
  || !toolsSource.includes('.tool-session-link')
  || !toolsSource.includes('.tool-kind-svg')) {
  throw new Error('工具分析正式样式必须保留指标、表格、关注项、会话钻取和 SVG 工具图标能力')
}

if (!insightsSource.includes('使用洞察正式样式')) {
  throw new Error('insights.css 必须明确作为使用洞察正式样式所有者')
}
if (!insightsSource.includes('.insight-kpi-grid')
  || !insightsSource.includes('.insight-trend')
  || !insightsSource.includes('.insight-pattern-list')) {
  throw new Error('使用洞察正式样式必须保留指标、趋势与工作流模式能力')
}

if (!agentsSource.includes('智能体概览正式样式')) {
  throw new Error('agents.css 必须明确作为智能体概览正式样式所有者')
}
if (!agentsSource.includes(".agent-card[data-source='hermes']")
  || !agentsSource.includes(".agent-card[data-source='opencode']")
  || !agentsSource.includes('.frequent-asset-row')
  || !agentsSource.includes('.skill-funnel')) {
  throw new Error('智能体概览正式样式必须保留五来源扩展、高频资产和技能漏斗能力')
}

if (!backupSource.includes('AgentLens 1.0 资产备份正式样式')
  || !backupSource.includes('正在扫描资产备份范围')
  || !backupSource.includes('.snapshot-builder')
  || !backupSource.includes('.preview-summary')) {
  throw new Error('backup.css 必须保留正式所有者标识、首次扫描反馈、快照创建器与恢复预演能力')
}

if (!reviewSource.includes('AgentLens 1.0 任务复盘正式样式')) {
  throw new Error('review.css 必须明确作为任务复盘正式样式所有者')
}
if (!/\.chat-bubble-user\s*\{[\s\S]*?background:\s*var\(--al-user-bubble\);[\s\S]*?color:\s*var\(--al-user-bubble-text\);/m.test(reviewSource)) {
  throw new Error('任务复盘用户气泡必须直接消费专用用户气泡 Token')
}
if (!/\.chat-row-user\s*\{[^}]*align-items:\s*flex-end/m.test(reviewSource)
  || !/\.chat-row-agent\s*\{[^}]*align-items:\s*flex-start/m.test(reviewSource)) {
  throw new Error('任务复盘必须保持用户右侧、智能体左侧')
}
if (!/\.event-row\s*\{[\s\S]*?grid-template-columns:\s*18px\s+minmax\(0,1fr\)/m.test(reviewSource)) {
  throw new Error('任务复盘生命周期/语义事件必须保持单排轨迹结构')
}
if (!reviewSource.includes('.evidence-inline') || !reviewSource.includes('.raw-event-group') || !reviewSource.includes('.pi-session-tree')) {
  throw new Error('任务复盘必须保留证据、原始记录和 Pi 会话树表现能力')
}
if (!reviewLongSource.includes('.turn-rail') || !reviewLongSource.includes('.turn-tick')) {
  throw new Error('长会话样式必须保留轮次轨导航能力')
}

try {
  new Function(mockAppSource)
} catch (error) {
  throw new Error(`当前高保真原型共享脚本存在语法错误：${error instanceof Error ? error.message : String(error)}`)
}

function block(source, selector) {
  const start = source.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`缺少设计令牌块：${selector}`)
  const bodyStart = source.indexOf('{', start) + 1
  const end = source.indexOf('}', bodyStart)
  return source.slice(bodyStart, end)
}

function vars(sourceBlock) {
  return new Map([...sourceBlock.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]))
}

const comparedTokens = [
  '--al-canvas', '--al-surface', '--al-surface-raised', '--al-soft', '--al-soft-2',
  '--al-line', '--al-line-strong', '--al-ink', '--al-ink-2', '--al-muted', '--al-muted-2',
  '--al-accent', '--al-accent-soft', '--al-success', '--al-success-soft', '--al-warning',
  '--al-warning-soft', '--al-danger', '--al-danger-soft', '--al-user-bubble',
  '--al-user-bubble-text', '--al-user-bubble-muted', '--al-user-bubble-code',
  '--src-codex', '--src-claude', '--src-pi', '--src-hermes', '--src-opencode',
]

const runtimeLight = vars(block(tokenSource, ':root'))
const runtimeDark = vars(block(tokenSource, ":root[data-theme='dark']"))
const mockLight = vars(block(mockTokenSource, ':root'))
const mockDark = vars(block(mockTokenSource, ":root[data-theme='dark']"))
for (const name of comparedTokens) {
  if (runtimeLight.get(name)?.toLowerCase() !== mockLight.get(name)?.toLowerCase()) {
    throw new Error(`浅色设计令牌与高保真原型不一致：${name}`)
  }
  if (runtimeDark.get(name)?.toLowerCase() !== mockDark.get(name)?.toLowerCase()) {
    throw new Error(`暗色设计令牌与高保真原型不一致：${name}`)
  }
}

function hexToRgb(value) {
  const hex = value.trim()
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`对比度检查只接受 6 位 HEX：${hex}`)
  return [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
}
function luminance(value) {
  const [r, g, b] = hexToRgb(value).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(foreground, background) {
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
function assertContrast(label, foreground, background, minimum = 4.5) {
  const ratio = contrast(foreground, background)
  if (ratio < minimum) throw new Error(`${label} 对比度不足：${ratio.toFixed(2)} < ${minimum}`)
}

for (const [label, foreground, background] of [
  ['浅色正文/画布', runtimeLight.get('--al-ink'), runtimeLight.get('--al-canvas')],
  ['浅色次要文字/软底', runtimeLight.get('--al-muted'), runtimeLight.get('--al-soft')],
  ['浅色用户气泡', runtimeLight.get('--al-user-bubble-text'), runtimeLight.get('--al-user-bubble')],
  ['暗色正文/画布', runtimeDark.get('--al-ink'), runtimeDark.get('--al-canvas')],
  ['暗色次要文字/软底', runtimeDark.get('--al-muted'), runtimeDark.get('--al-soft')],
  ['暗色用户气泡', runtimeDark.get('--al-user-bubble-text'), runtimeDark.get('--al-user-bubble')],
]) assertContrast(label, foreground, background)

if (!mockCurrentSource.includes('.snapshot-builder .builder-block')
  || !mockCurrentSource.includes('.snapshot-builder .builder-checks')) {
  throw new Error('资产备份当前稿必须使用正式的分组快照创建器结构')
}
if (!mockCurrentSource.includes('repeat(5,minmax(90px,1fr))')) {
  throw new Error('智能体当前稿必须保留五来源覆盖矩阵布局')
}
if (!mockCurrentSource.includes('@media (max-width: 900px)')
  || !mockCurrentSource.includes('@media (max-width: 560px)')) {
  throw new Error('当前稿必须锁定 900px / 560px 的关键响应式断点')
}
if (!mockAppSource.includes('nextDirection')
  || !mockAppSource.includes("event.key !== 'Enter' && event.key !== ' '")) {
  throw new Error('当前原型必须支持双向排序和 Enter / Space 键盘操作')
}
if ((mockToolsSource.match(/data-sort="num"/g) ?? []).length !== 5) {
  throw new Error('工具分析当前稿必须为五个数值表头提供真实排序数据')
}
if (!mockAppSource.includes('builder-summary') || !mockAppSource.includes('preview-summary')) {
  throw new Error('资产备份当前稿必须包含创建摘要和恢复预演摘要')
}
if (!appSource.includes('className={`status-pill status-tip') || !appSource.includes('data-tip={healthTitle}')) {
  throw new Error('正式顶部运行状态必须使用自定义提示卡')
}

console.log('Web 表现层收敛检查通过：旧原型/阶段覆盖层已退役，基础层与页面所有者边界、12px 下限、设计令牌、关键交互、响应式与对比度均已校验')
