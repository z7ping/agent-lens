import { existsSync, readFileSync } from 'node:fs'

const mainPath = 'packages/web/src/main.tsx'
const typographyPath = 'packages/web/src/typography.css'
const convergencePath = 'packages/web/src/v2-1.css'
const retiredReviewLayers = [
  'packages/web/src/review-balanced.css',
  'packages/web/src/review-balanced-runtime.ts',
  'packages/web/src/review-polish.css',
]

const main = readFileSync(mainPath, 'utf8')
const cssImports = [...main.matchAll(/import\s+['"](.+?\.css)['"]/g)].map(match => match[1])
const lastCssImport = cssImports.at(-1)

if (lastCssImport !== './typography.css') {
  throw new Error(`Web 字体系统必须最后加载，当前最后一个 CSS 是：${lastCssImport ?? '无'}`)
}

for (const path of retiredReviewLayers) {
  if (existsSync(path)) {
    throw new Error(`已退役的任务复盘表现层不应重新出现：${path}`)
  }
}

const typography = readFileSync(typographyPath, 'utf8')
if (!/--font-size-xs:\s*12px\s*;/.test(typography)) {
  throw new Error('正式字体系统的最小语义字号必须保持为 12px')
}

for (const path of [typographyPath, convergencePath]) {
  const source = readFileSync(path, 'utf8')
  const tooSmall = [...source.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px\b/g)]
    .map(match => Number(match[1]))
    .filter(value => value < 12)

  if (tooSmall.length > 0) {
    throw new Error(`${path} 出现小于 12px 的最终字号：${[...new Set(tooSmall)].join(', ')}px`)
  }
}

console.log('Web 表现层收敛检查通过')
