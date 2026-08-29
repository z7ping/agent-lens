import { existsSync, readFileSync } from 'node:fs'

const mainPath = 'packages/web/src/main.tsx'
const stylesPath = 'packages/web/src/styles.css'
const tokenPath = 'packages/web/src/tokens.css'
const themePath = 'packages/web/src/theme.css'
const typographyPath = 'packages/web/src/typography.css'
const readabilityPath = 'packages/web/src/readability.css'
const semanticColorPath = 'packages/web/src/semantic-colors.css'
const shellPath = 'packages/web/src/shell.css'
const shellResponsivePath = 'packages/web/src/shell-responsive.css'
const statesPath = 'packages/web/src/states.css'
const desktopResponsivePath = 'packages/web/src/desktop-responsive.css'
const toolsPath = 'packages/web/src/tools.css'
const insightsPath = 'packages/web/src/insights.css'
const agentsPath = 'packages/web/src/agents.css'
const backupPath = 'packages/web/src/backup.css'
const backupResponsivePath = 'packages/web/src/backup-responsive.css'
const reviewPath = 'packages/web/src/review.css'
const reviewLongPath = 'packages/web/src/review-long-session.css'

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
const cssImports = [...main.matchAll(/import\s+['"](.+?\.css)['"]/g)].map(match => match[1])
const indexOf = path => cssImports.indexOf(path)

for (const path of retiredLayers) {
  if (existsSync(path)) throw new Error(`已退役的表现覆盖层不应重新出现：${path}`)
}

const requiredImports = [
  './styles.css',
  './tokens.css',
  './theme.css',
  './typography.css',
  './readability.css',
  './semantic-colors.css',
  './shell.css',
  './shell-responsive.css',
  './states.css',
  './backup.css',
  './backup-responsive.css',
  './insights.css',
  './tools.css',
  './agents.css',
  './review.css',
  './review-long-session.css',
  './desktop-responsive.css',
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
  throw new Error('正式样式顺序必须保持：全局基础 → 设计令牌/主题 → 共享语义色 → 壳层 → 页面所有者；长会话性能层紧随 review.css')
}
if (!(indexOf('./desktop-responsive.css') < indexOf('./backup-responsive.css'))) {
  throw new Error('资产备份响应式所有者必须在通用 Desktop 响应式基线之后加载')
}

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
  themePath,
  typographyPath,
  readabilityPath,
  semanticColorPath,
  shellPath,
  shellResponsivePath,
  statesPath,
  desktopResponsivePath,
  toolsPath,
  insightsPath,
  agentsPath,
  backupPath,
  backupResponsivePath,
  reviewPath,
  reviewLongPath,
]
for (const path of semanticPresentationPaths) {
  const source = readFileSync(path, 'utf8')
  const tooSmall = declaredPixelFontSizes(source).filter(value => value > 0 && value < 12)
  if (tooSmall.length) {
    throw new Error(`${path} 出现小于 12px 的当前有效字号：${[...new Set(tooSmall)].join(', ')}px`)
  }
}

const stylesSource = readFileSync(stylesPath, 'utf8')
const tokenSource = readFileSync(tokenPath, 'utf8')
const themeSource = readFileSync(themePath, 'utf8')
const shellSource = readFileSync(shellPath, 'utf8')
const shellResponsiveSource = readFileSync(shellResponsivePath, 'utf8')
const statesSource = readFileSync(statesPath, 'utf8')
const desktopResponsiveSource = readFileSync(desktopResponsivePath, 'utf8')
const toolsSource = readFileSync(toolsPath, 'utf8')
const insightsSource = readFileSync(insightsPath, 'utf8')
const agentsSource = readFileSync(agentsPath, 'utf8')
const backupSource = readFileSync(backupPath, 'utf8')
const backupResponsiveSource = readFileSync(backupResponsivePath, 'utf8')
const reviewSource = readFileSync(reviewPath, 'utf8')
const reviewLongSource = readFileSync(reviewLongPath, 'utf8')
const semanticColorSource = readFileSync(semanticColorPath, 'utf8')

for (const [name, source] of [
  ['theme.css', themeSource],
  ['shell.css', shellSource],
  ['shell-responsive.css', shellResponsiveSource],
  ['states.css', statesSource],
  ['desktop-responsive.css', desktopResponsiveSource],
  ['semantic-colors.css', semanticColorSource],
  ['tools.css', toolsSource],
  ['insights.css', insightsSource],
  ['agents.css', agentsSource],
  ['backup.css', backupSource],
  ['backup-responsive.css', backupResponsiveSource],
  ['review.css', reviewSource],
]) {
  if (/!important\b/.test(source)) throw new Error(`${name} 作为正式所有者文件不得依赖 !important 争夺优先级`)
}

if (!stylesSource.includes('AgentLens 1.0 全局基础样式')) throw new Error('styles.css 必须明确保持为全局基础层')
if (/\.app-header\b|\.tool-summary-grid\b|\.agent-card\b|\.review-page\b/.test(stylesSource)) {
  throw new Error('styles.css 不得重新承载壳层或一级页面专属规则')
}
if (!/\.btn\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?height:\s*30px;[\s\S]*?font-size:\s*12px;[\s\S]*?white-space:\s*nowrap;/m.test(stylesSource)) {
  throw new Error('共享按钮必须保持 v2.1 契约：inline-flex、30px 高、12px 字号且图文不换行')
}

const duplicatedCoreTokens = [
  '--al-canvas', '--al-surface', '--al-soft', '--al-line', '--al-ink', '--al-accent',
].filter(token => new RegExp(`${token.replaceAll('-', '\\-')}\\s*:`).test(themeSource))
if (duplicatedCoreTokens.length) {
  throw new Error(`theme.css 不得重新声明基础设计令牌：${duplicatedCoreTokens.join(', ')}`)
}

if (!/\.app-header\s*\{[\s\S]*?backdrop-filter\s*:\s*none/m.test(shellSource)) {
  throw new Error('正式 Header 必须由 shell.css 关闭背景模糊')
}
if (!shellSource.includes('.status-tip::after') || !shellSource.includes('white-space: pre-line')) {
  throw new Error('正式顶部运行状态提示卡必须支持多行事实说明')
}
if (!/\.workspace-toolbar\s*\{[\s\S]*?height:\s*50px;[\s\S]*?min-height:\s*50px;/m.test(shellSource)) {
  throw new Error('工作区工具栏必须保持 50px 正式基线')
}
if (!/\.filter\s*\{[\s\S]*?height:\s*34px;[\s\S]*?font-size:\s*13px;/m.test(shellSource)) {
  throw new Error('筛选控件必须保持 34px / 13px 正式基线')
}
if (!/\.scope-chip\s*\{[\s\S]*?height:\s*32px;[\s\S]*?font-size:\s*13px;/m.test(shellSource)) {
  throw new Error('智能体筛选 Chip 必须保持 32px / 13px 正式基线')
}
if (!/@media \(max-width: 575\.98px\)[\s\S]*?\.app-header \.brand\s*\{[\s\S]*?display:\s*flex/m.test(shellResponsiveSource)) {
  throw new Error('xs 窄窗口必须保留 AgentLens Logo，不能隐藏整个品牌区')
}

for (const breakpoint of ['1199.98px', '991.98px', '767.98px', '575.98px']) {
  if (!shellResponsiveSource.includes(breakpoint)) throw new Error(`shell-responsive.css 缺少 Bootstrap 响应式断点：${breakpoint}`)
}
for (const legacyBreakpoint of ['1080px', '1100px', '900px', '820px', '760px', '560px']) {
  if (shellResponsiveSource.includes(legacyBreakpoint) || statesSource.includes(legacyBreakpoint)) {
    throw new Error(`壳层/状态层不得恢复一次性自定义断点：${legacyBreakpoint}`)
  }
}
if (!desktopResponsiveSource.includes('1280×800 / 1366×768')
  || !desktopResponsiveSource.includes('md 768 / lg 992 / xl 1200 / xxl 1400')) {
  throw new Error('Desktop 响应式基线必须明确 1280/1366 主设计尺寸和 Bootstrap 5 断点')
}
if (!backupResponsiveSource.includes('1280×800 / 1366×768')
  || !backupResponsiveSource.includes('@media (min-width: 1200px) and (max-width: 1399.98px)')
  || !backupResponsiveSource.includes('white-space: nowrap')
  || !backupResponsiveSource.includes('grid-column: 1 / -1')) {
  throw new Error('资产备份必须保留 xl 主桌面布局和操作按钮不换行契约')
}

if (!toolsSource.includes('工具分析正式样式')
  || !toolsSource.includes('.tool-summary-grid')
  || !toolsSource.includes('.tool-table-card')
  || !toolsSource.includes('.tool-attention-row')
  || !toolsSource.includes('.tool-session-link')
  || !toolsSource.includes('.tool-kind-svg')) {
  throw new Error('工具分析正式样式必须保留指标、表格、关注项、会话钻取和 SVG 工具图标能力')
}

if (!insightsSource.includes('使用洞察正式样式')
  || !insightsSource.includes('.insight-kpi-grid')
  || !insightsSource.includes('.insight-trend')
  || !insightsSource.includes('.insight-pattern-list')) {
  throw new Error('使用洞察正式样式必须保留指标、趋势与工作流模式能力')
}

if (!agentsSource.includes('智能体概览正式样式')
  || !agentsSource.includes(".agent-card[data-source='hermes']")
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

if (!reviewSource.includes('AgentLens 1.0 任务复盘正式样式')) throw new Error('review.css 必须明确作为任务复盘正式样式所有者')
if (!/\.chat-bubble-user\s*\{[\s\S]*?background:\s*var\(--al-user-bubble\);[\s\S]*?color:\s*var\(--al-user-bubble-text\);/m.test(reviewSource)) {
  throw new Error('任务复盘用户气泡必须直接消费专用用户气泡 Token')
}
if (!/\.chat-row-user\s*\{[^}]*align-items:\s*flex-end/m.test(reviewSource)
  || !/\.chat-row-agent\s*\{[^}]*align-items:\s*flex-start/m.test(reviewSource)) {
  throw new Error('任务复盘必须保持用户右侧、智能体左侧')
}
if (!reviewSource.includes('.evidence-inline') || !reviewSource.includes('.raw-event-group') || !reviewSource.includes('.pi-session-tree')) {
  throw new Error('任务复盘必须保留证据、原始记录和 Pi 会话树表现能力')
}
if (!reviewLongSource.includes('.turn-rail') || !reviewLongSource.includes('.turn-tick')) {
  throw new Error('长会话样式必须保留轮次轨导航能力')
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

const runtimeLight = vars(block(tokenSource, ':root'))
const runtimeDark = vars(block(tokenSource, ":root[data-theme='dark']"))
for (const [label, foreground, background] of [
  ['浅色正文/画布', runtimeLight.get('--al-ink'), runtimeLight.get('--al-canvas')],
  ['浅色次要文字/软底', runtimeLight.get('--al-muted'), runtimeLight.get('--al-soft')],
  ['浅色用户气泡', runtimeLight.get('--al-user-bubble-text'), runtimeLight.get('--al-user-bubble')],
  ['暗色正文/画布', runtimeDark.get('--al-ink'), runtimeDark.get('--al-canvas')],
  ['暗色次要文字/软底', runtimeDark.get('--al-muted'), runtimeDark.get('--al-soft')],
  ['暗色用户气泡', runtimeDark.get('--al-user-bubble-text'), runtimeDark.get('--al-user-bubble')],
]) {
  if (!foreground || !background) throw new Error(`${label} 缺少设计令牌`)
  assertContrast(label, foreground, background)
}

console.log('AgentLens 正式 Web 表现检查通过：设计令牌、控件契约、Bootstrap 响应式、桌面主基线、字号与关键页面能力均已锁定。')
