import { existsSync, readFileSync } from 'node:fs'

const mainPath = 'packages/web/src/main.tsx'
const typographyPath = 'packages/web/src/typography.css'
const tokenPath = 'packages/web/src/tokens.css'
const mockTokenPath = 'docs/design/mockups/v2/assets/tokens.css'
const mockCurrentPath = 'docs/design/mockups/v2/assets/current.css'
const mockAppPath = 'docs/design/mockups/v2/assets/app.js'
const mockToolsPath = 'docs/design/mockups/v2/tools.html'
const colorSystemPath = 'packages/web/src/color-system.css'
const finalAlignmentPath = 'packages/web/src/v2-alignment.css'
const reviewReferencePath = 'packages/web/src/review-reference.css'
const semanticPresentationPaths = [
  typographyPath,
  'packages/web/src/insights.css',
  'packages/web/src/review-long-session.css',
  'packages/web/src/shell-responsive.css',
  finalAlignmentPath,
  mockCurrentPath,
]
const retiredReviewLayers = [
  'packages/web/src/review-balanced.css',
  'packages/web/src/review-balanced-runtime.ts',
  'packages/web/src/review-polish.css',
  'packages/web/src/v2-1.css',
]

const main = readFileSync(mainPath, 'utf8')
const cssImports = [...main.matchAll(/import\s+['"](.+?\.css)['"]/g)].map(match => match[1])
const lastCssImport = cssImports.at(-1)

if (lastCssImport !== './v2-alignment.css') {
  throw new Error(`v2.1 最终对齐层必须最后加载，当前最后一个 CSS 是：${lastCssImport ?? '无'}`)
}

const typographyIndex = cssImports.indexOf('./typography.css')
const tokenIndex = cssImports.indexOf('./tokens.css')
const colorSystemIndex = cssImports.indexOf('./color-system.css')
const finalAlignmentIndex = cssImports.indexOf('./v2-alignment.css')
if (
  typographyIndex < 0 || tokenIndex < 0 || colorSystemIndex < 0 || finalAlignmentIndex < 0
  || typographyIndex > tokenIndex
  || tokenIndex + 1 !== colorSystemIndex
  || colorSystemIndex + 1 !== finalAlignmentIndex
) {
  throw new Error('正式加载顺序必须保持：字体系统 → 设计令牌 → 最终配色系统 → v2.1 最终对齐层')
}

for (const path of retiredReviewLayers) {
  if (existsSync(path)) {
    throw new Error(`已退役的表现层不应重新出现：${path}`)
  }
}

if (!existsSync(mockCurrentPath)) {
  throw new Error('当前高保真原型必须保留 assets/current.css 作为最终表现契约')
}
if (!existsSync(mockAppPath)) {
  throw new Error('当前高保真原型必须保留 assets/app.js 作为共享交互契约')
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

for (const path of semanticPresentationPaths) {
  const source = readFileSync(path, 'utf8')
  const tooSmall = declaredPixelFontSizes(source).filter(value => value < 12)

  if (tooSmall.length > 0) {
    throw new Error(`${path} 出现小于 12px 的当前有效字号：${[...new Set(tooSmall)].join(', ')}px`)
  }
}

const tokenSource = readFileSync(tokenPath, 'utf8')
const mockTokenSource = readFileSync(mockTokenPath, 'utf8')
const mockCurrentSource = readFileSync(mockCurrentPath, 'utf8')
const mockAppSource = readFileSync(mockAppPath, 'utf8')
const mockToolsSource = readFileSync(mockToolsPath, 'utf8')
const colorSystemSource = readFileSync(colorSystemPath, 'utf8')
const finalAlignmentSource = readFileSync(finalAlignmentPath, 'utf8')
const reviewReferenceSource = readFileSync(reviewReferencePath, 'utf8')

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
    throw new Error(`浅色设计令牌与高保真原型不一致：${name}，正式=${runtimeLight.get(name)}，原型=${mockLight.get(name)}`)
  }
  if (runtimeDark.get(name)?.toLowerCase() !== mockDark.get(name)?.toLowerCase()) {
    throw new Error(`暗色设计令牌与高保真原型不一致：${name}，正式=${runtimeDark.get(name)}，原型=${mockDark.get(name)}`)
  }
}

function hexToRgb(value) {
  const hex = value.trim()
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`对比度检查只接受 6 位 HEX：${hex}`)
  return [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
}

function luminance(value) {
  const [r, g, b] = hexToRgb(value).map(channel => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(foreground, background) {
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function assertContrast(label, foreground, background, minimum = 4.5) {
  const ratio = contrast(foreground, background)
  if (ratio < minimum) {
    throw new Error(`${label} 对比度不足：${ratio.toFixed(2)} < ${minimum}（${foreground} / ${background}）`)
  }
}

const contrastPairs = [
  ['浅色正文/画布', runtimeLight.get('--al-ink'), runtimeLight.get('--al-canvas')],
  ['浅色次要文字/软底', runtimeLight.get('--al-muted'), runtimeLight.get('--al-soft')],
  ['浅色用户气泡', runtimeLight.get('--al-user-bubble-text'), runtimeLight.get('--al-user-bubble')],
  ['浅色强调实底', '#FFFFFF', runtimeLight.get('--al-accent')],
  ['浅色成功实底', '#FFFFFF', runtimeLight.get('--al-success')],
  ['浅色警告实底', '#FFFFFF', runtimeLight.get('--al-warning')],
  ['浅色危险实底', '#FFFFFF', runtimeLight.get('--al-danger')],
  ['暗色正文/画布', runtimeDark.get('--al-ink'), runtimeDark.get('--al-canvas')],
  ['暗色次要文字/软底', runtimeDark.get('--al-muted'), runtimeDark.get('--al-soft')],
  ['暗色用户气泡', runtimeDark.get('--al-user-bubble-text'), runtimeDark.get('--al-user-bubble')],
  ['暗色强调实底', '#171816', runtimeDark.get('--al-accent')],
  ['暗色成功实底', '#171816', runtimeDark.get('--al-success')],
  ['暗色警告实底', '#171816', runtimeDark.get('--al-warning')],
  ['暗色危险实底', '#171816', runtimeDark.get('--al-danger')],
]

for (const [label, foreground, background] of contrastPairs) {
  assertContrast(label, foreground, background)
}

if (!colorSystemSource.includes('AgentLens 1.0 最终配色收口层')) {
  throw new Error('最终配色系统文件缺少正式收口标识')
}
if (!finalAlignmentSource.includes('AgentLens v2.1 当前高保真原型最终对齐层')) {
  throw new Error('v2.1 最终对齐层缺少当前高保真基线标识')
}
if (!/\.app-header\s*\{[\s\S]*?backdrop-filter\s*:\s*none/m.test(finalAlignmentSource)) {
  throw new Error('正式 Header 必须在最终对齐层关闭背景模糊')
}
if (!/\.app-header\s*,\s*\n?\.round-nav\s*\{[\s\S]*?backdrop-filter\s*:\s*none\s*!important/m.test(mockCurrentSource)) {
  throw new Error('当前高保真原型必须关闭 Header / round-nav 背景模糊')
}
if (!mockCurrentSource.includes('.dot-hermes') || !mockCurrentSource.includes('.dot-opencode')) {
  throw new Error('当前高保真原型必须包含 Hermes / OpenCode 来源色')
}
if (!/\.app-header\s+\.brand\s*\{\s*display:\s*flex\s*!important/m.test(finalAlignmentSource)) {
  throw new Error('窄窗口必须保留 AgentLens Logo，不能隐藏整个品牌区')
}

/* 第二轮 1:1 契约：五来源详情、当前原型结构和真实交互都必须被锁住。 */
if (!finalAlignmentSource.includes(".agent-card[data-source='hermes']")
  || !finalAlignmentSource.includes(".agent-card[data-source='opencode']")) {
  throw new Error('正式智能体详情卡必须为 Hermes / OpenCode 使用稳定来源强调色')
}
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

/*
 * Token 数值正确并不足够：高特异性的历史组件规则仍可能覆盖背景，
 * 再和低特异性的前景色规则拼成“浅底浅字”。这里直接验证最终组件绑定。
 */
const reviewUserBubbleRule = /\.review-page\s+\.chat-bubble-user\s*,[\s\S]*?\{[\s\S]*?background\s*:\s*var\(--al-user-bubble\)\s*!important\s*;[\s\S]*?color\s*:\s*var\(--al-user-bubble-text\)\s*!important\s*;/m
if (!reviewUserBubbleRule.test(colorSystemSource)) {
  throw new Error('用户消息气泡必须在最终配色层以 Review 级特异性绑定 --al-user-bubble / --al-user-bubble-text')
}

const referenceUserBubbleRule = /\.review-page\s+\.chat-bubble-user\s*\{([^}]*)\}/m.exec(reviewReferenceSource)
if (!referenceUserBubbleRule) {
  throw new Error('任务复盘高保真层缺少用户消息气泡规则')
}
if (!/background\s*:\s*var\(--al-user-bubble\)\s*!important/.test(referenceUserBubbleRule[1])
  || !/color\s*:\s*var\(--al-user-bubble-text\)\s*!important/.test(referenceUserBubbleRule[1])) {
  throw new Error('任务复盘高保真层必须直接消费用户气泡专用 Token')
}
if (/--al-accent-soft/.test(referenceUserBubbleRule[1])) {
  throw new Error('任务复盘用户气泡不得回退到 --al-accent-soft 浅色背景')
}

const userMarkdownRule = /\.chat-bubble-user\s+\.markdown[\s\S]*?color\s*:\s*var\(--al-user-bubble-text\)\s*!important\s*;/m
if (!userMarkdownRule.test(colorSystemSource)) {
  throw new Error('用户消息 Markdown 正文必须绑定 --al-user-bubble-text，不能继承普通页面文字色')
}

console.log('Web 表现层收敛检查通过：加载顺序、12px 下限、五来源、1:1 原型结构、键盘交互、响应式契约和关键对比度均已校验')