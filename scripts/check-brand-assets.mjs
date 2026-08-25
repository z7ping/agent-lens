import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const read = path => readFileSync(resolve(root, path), 'utf8')
const requireText = (condition, message) => {
  if (!condition) throw new Error(`[brand-assets] ${message}`)
}

const fullSvgPath = 'packages/web/public/agentlens-icon.svg'
const smallSvgPath = 'packages/web/public/agentlens-icon-small.svg'
requireText(existsSync(resolve(root, fullSvgPath)), '缺少主品牌 SVG')
requireText(existsSync(resolve(root, smallSvgPath)), '缺少小尺寸品牌 SVG')

const fullSvg = read(fullSvgPath)
const smallSvg = read(smallSvgPath)
for (const svg of [fullSvg, smallSvg]) {
  requireText(svg.includes('#1768f2') && svg.includes('#20d8cf'), '品牌蓝青渐变缺失')
  requireText(svg.includes('#ffc22b') && svg.includes('#ff7a21'), '聚焦橙色缺失')
  requireText(svg.includes('stroke="#fff"'), '轨迹线缺失')
}

const masterSvgPaths = [
  'docs/brand/logo/agentlens-logo.svg',
  'docs/brand/logo/agentlens-logo-small.svg',
  'docs/brand/logo/concepts/concept-01.svg',
  'docs/brand/logo/concepts/concept-02.svg',
  'docs/brand/logo/concepts/concept-03.svg',
  'docs/brand/logo/concepts/concept-04.svg',
  'docs/brand/logo/concepts/concept-05-final.svg',
  'docs/brand/logo/concepts/concept-06.svg',
]
for (const path of masterSvgPaths) {
  requireText(existsSync(resolve(root, path)), `缺少品牌 SVG 主源：${path}`)
  const svg = read(path)
  requireText(/<svg\b[^>]*\bviewBox="[^"]+"/i.test(svg), `品牌 SVG 主源缺少独立 viewBox：${path}`)
  requireText(!/<(?:image|foreignObject|script)\b/i.test(svg), `品牌 SVG 主源不得包含位图、外部对象或脚本：${path}`)
  requireText(!/(?:href|xlink:href)="(?:https?:|data:image)/i.test(svg), `品牌 SVG 主源不得依赖外链或嵌入位图：${path}`)
  requireText(!/<text\b/i.test(svg), `品牌 SVG 主源不得依赖字体渲染；文字需转为矢量几何：${path}`)
  requireText(!/@font-face|font-family\s*:/i.test(svg), `品牌 SVG 主源不得依赖字体：${path}`)
  requireText(!/<style\b[^>]*>[\s\S]*?@import/i.test(svg), `品牌 SVG 主源不得导入外部样式：${path}`)
}

for (const path of ['README.md', 'README.zh-CN.md']) {
  const readme = read(path)
  requireText(readme.includes('docs/brand/logo/agentlens-logo.svg'), `仓库首页未使用正式品牌 Logo：${path}`)
}

const index = read('packages/web/index.html')
requireText(index.includes('/agentlens-icon-small.svg'), 'Web favicon 未使用小尺寸品牌图标')
requireText(!index.includes('/favicon.ico') && !index.includes('/favicon.png'), 'Web 仍引用旧 favicon')

const app = read('packages/web/src/App.tsx')
requireText(app.includes('src="/agentlens-icon.svg"'), 'Web Header 未使用主品牌图标')

const mockApp = read('docs/design/mockups/v2/assets/app.js')
requireText(mockApp.includes('packages/web/public/agentlens-icon.svg'), '高保真原型未使用主品牌图标')

const desktopPackage = read('apps/desktop/package.json')
requireText(desktopPackage.includes('"icon": "assets/icon-app.ico"'), 'Windows EXE/安装器未使用多尺寸 ICO')
requireText(desktopPackage.includes('prepare-windows-icon.ps1'), '桌面启动/打包未经过品牌资产生成器')

const desktopMain = read('apps/desktop/src/main.mjs')
requireText(desktopMain.includes("unpackedAsset('assets', 'icon-window.png')"), '桌面窗口未使用 256px 专用图标')
requireText(desktopMain.includes("unpackedAsset('assets', 'tray.ico')"), '桌面托盘未使用多尺寸 ICO')
requireText(!desktopMain.includes("unpackedAsset('assets', 'icon.png')"), '桌面入口仍保留旧 icon.png 兜底')

const generator = read('scripts/prepare-windows-icon.ps1')
requireText(generator.includes('@(16, 20, 24, 32, 40, 48, 64, 128, 256)'), '应用 ICO 尺寸矩阵不完整')
requireText(generator.includes('@(16, 20, 24, 32, 40, 48)'), '托盘 ICO 尺寸矩阵不完整')
requireText(generator.includes('Draw-SmallIcon'), '缺少小尺寸专用几何')

const gitignore = read('.gitignore')
for (const asset of ['icon-app.ico', 'icon-window.png', 'tray.ico']) {
  requireText(gitignore.includes(`apps/desktop/assets/${asset}`), `生成资产未加入 .gitignore：${asset}`)
}

console.log('AgentLens 品牌图标检查通过：README、正式图标引用与品牌存档 SVG 均已统一。')
