import { existsSync, readFileSync } from 'node:fs'

const mainPath = 'packages/web/src/main.tsx'
const typographyPath = 'packages/web/src/typography.css'
const tokenPath = 'packages/web/src/tokens.css'
const mockTokenPath = 'docs/design/mockups/v2/assets/tokens.css'
const colorSystemPath = 'packages/web/src/color-system.css'
const semanticPresentationPaths = [
  typographyPath,
  'packages/web/src/insights.css',
  'packages/web/src/review-long-session.css',
  'packages/web/src/shell-responsive.css',
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

if (lastCssImport !== './color-system.css') {
  throw new Error(`Web 最终配色系统必须最后加载，当前最后一个 CSS 是：${lastCssImport ?? '无'}`)
}

const typographyIndex = cssImports.indexOf('./typography.css')
const tokenIndex = cssImports.indexOf('./tokens.css')
const colorSystemIndex = cssImports.indexOf('./color-system.css')
if (typographyIndex < 0 || tokenIndex < 0 || colorSystemIndex < 0 || typographyIndex > tokenIndex || tokenIndex + 1 !== colorSystemIndex) {
  throw new Error('正式加载顺序必须保持：字体系统 → 设计令牌 → 最终配色系统')
}

for (const path of retiredReviewLayers) {
  if (existsSync(path)) {
    throw new Error(`已退役的表现层不应重新出现：${path}`)
  }
}

const typography = readFileSync(typographyPath, 'utf8')
if (!/--font-size-xs:\s*12px\s*;/.test(typography)) {
  throw new Error('正式字体系统的最小语义字号必须保持为 12px')
}

for (const path of semanticPresentationPaths) {
  const source = readFileSync(path, 'utf8')
  const tooSmall = [...source.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px\b/g)]
    .map(match => Number(match[1]))
    .filter(value => value < 12)

  if (tooSmall.length > 0) {
    throw new Error(`${path} 出现小于 12px 的正式字号：${[...new Set(tooSmall)].join(', ')}px`)
  }
}

const tokenSource = readFileSync(tokenPath, 'utf8')
const mockTokenSource = readFileSync(mockTokenPath, 'utf8')
const colorSystemSource = readFileSync(colorSystemPath, 'utf8')

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

/*
 * Token 数值正确并不足够：高特异性的历史组件规则仍可能覆盖背景，
 * 再和低特异性的前景色规则拼成“浅底浅字”。这里直接验证最终组件绑定。
 */
const reviewUserBubbleRule = /\.review-page\s+\.chat-bubble-user\s*,[\s\S]*?\{[\s\S]*?background\s*:\s*var\(--al-user-bubble\)\s*!important\s*;[\s\S]*?color\s*:\s*var\(--al-user-bubble-text\)\s*!important\s*;/m
if (!reviewUserBubbleRule.test(colorSystemSource)) {
  throw new Error('用户消息气泡必须在最终配色层以 Review 级特异性绑定 --al-user-bubble / --al-user-bubble-text')
}

const userMarkdownRule = /\.chat-bubble-user\s+\.markdown[\s\S]*?color\s*:\s*var\(--al-user-bubble-text\)\s*!important\s*;/m
if (!userMarkdownRule.test(colorSystemSource)) {
  throw new Error('用户消息 Markdown 正文必须绑定 --al-user-bubble-text，不能继承普通页面文字色')
}

console.log('Web 表现层收敛检查通过：字号、原型令牌、组件绑定和关键前景/背景对比度均已校验')
