import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const read = path => readFileSync(resolve(root, path), 'utf8')
const requireText = (condition, message) => {
  if (!condition) throw new Error(`[brand-assets] ${message}`)
}

const canonicalPath = 'docs/design/brand/agentlens-icon-master.svg'
const fullSvgPath = 'packages/web/public/agentlens-icon.svg'
const smallSvgPath = 'packages/web/public/agentlens-icon-small.svg'
const archiveFullPath = 'docs/brand/logo/agentlens-logo.svg'
const archiveSmallPath = 'docs/brand/logo/agentlens-logo-small.svg'
const desktopBuildSvgPath = 'apps/desktop/build/icon.svg'

for (const path of [canonicalPath, fullSvgPath, smallSvgPath, archiveFullPath, archiveSmallPath, desktopBuildSvgPath]) {
  requireText(existsSync(resolve(root, path)), `缺少品牌 SVG：${path}`)
}

const canonicalSvg = read(canonicalPath)
requireText(canonicalSvg.includes('AgentLens 应用图标矢量主母版'), '主母版 title 不是 AgentLens')
requireText(!canonicalSvg.includes('Narratica'), '主母版仍残留 Narratica 文案')
requireText(canonicalSvg.includes('#005DFF') && canonicalSvg.includes('#00DDE4'), '新品牌蓝青渐变缺失')
requireText(canonicalSvg.includes('#FFB10F') && canonicalSvg.includes('#FF7B20'), '新品牌橙色焦点缺失')
requireText(canonicalSvg.includes('viewBox="0 0 1254 1254"'), '主母版 viewBox 规格不正确')

for (const path of [fullSvgPath, smallSvgPath, archiveFullPath, archiveSmallPath, desktopBuildSvgPath]) {
  requireText(read(path) === canonicalSvg, `品牌派生 SVG 未与主母版逐字同步：${path}`)
}

const archivedSvgPaths = [
  canonicalPath,
  archiveFullPath,
  archiveSmallPath,
  'docs/brand/logo/concepts/concept-01.svg',
  'docs/brand/logo/concepts/concept-02.svg',
  'docs/brand/logo/concepts/concept-03.svg',
  'docs/brand/logo/concepts/concept-04.svg',
  'docs/brand/logo/concepts/concept-05-final.svg',
  'docs/brand/logo/concepts/concept-06.svg',
]
for (const path of archivedSvgPaths) {
  requireText(existsSync(resolve(root, path)), `缺少品牌 SVG 存档：${path}`)
  const svg = read(path)
  requireText(/<svg\b[^>]*\bviewBox="[^"]+"/i.test(svg), `品牌 SVG 缺少独立 viewBox：${path}`)
  requireText(!/<(?:image|foreignObject|script)\b/i.test(svg), `品牌 SVG 不得包含位图、外部对象或脚本：${path}`)
  requireText(!/(?:href|xlink:href)="(?:https?:|data:image)/i.test(svg), `品牌 SVG 不得依赖外链或嵌入位图：${path}`)
  requireText(!/<text\b/i.test(svg), `品牌 SVG 不得依赖字体渲染；文字需转为矢量几何：${path}`)
  requireText(!/@font-face|font-family\s*:/i.test(svg), `品牌 SVG 不得依赖字体：${path}`)
  requireText(!/<style\b[^>]*>[\s\S]*?@import/i.test(svg), `品牌 SVG 不得导入外部样式：${path}`)
}

for (const path of ['README.md', 'README.en.md']) {
  const readme = read(path)
  requireText(readme.includes('docs/brand/logo/agentlens-logo.svg'), `仓库首页未使用正式品牌 Logo：${path}`)
}

const index = read('packages/web/index.html')
requireText(index.includes('/agentlens-icon-small.svg'), 'Web favicon 未使用品牌图标')
requireText(!index.includes('/favicon.ico') && !index.includes('/favicon.png'), 'Web 仍引用旧 favicon')

const app = read('packages/web/src/App.tsx')
requireText(app.includes('src="/agentlens-icon.svg"'), 'Web Header 未使用主品牌图标')

const mockApp = read('docs/design/mockups/v2/assets/app.js')
requireText(mockApp.includes('packages/web/public/agentlens-icon.svg'), '最新版高保真原型未使用正式 Web 品牌图标')

const desktopPackage = read('apps/desktop/package.json')
requireText(desktopPackage.includes('"icon": "assets/icon-app.ico"'), 'Windows EXE/安装器未使用多尺寸 ICO')
requireText(desktopPackage.includes('prepare-windows-icon.ps1'), 'Windows 桌面启动/打包未经过品牌资产生成器')
requireText(desktopPackage.includes('"icon": "build/icon.icns"'), 'macOS App 未使用由品牌主母版生成的 ICNS')
requireText(desktopPackage.includes('prepare-macos-icon.sh'), 'macOS 桌面打包未经过品牌资产生成器')
requireText(desktopPackage.includes('"icon": "build/icon.svg"'), 'Linux App 未直接使用品牌 SVG 主母版派生资产')

const desktopMain = read('apps/desktop/src/main.mjs')
requireText(desktopMain.includes("unpackedAsset('assets', 'icon-window.png')"), 'Windows 桌面窗口未使用 256px 专用图标')
requireText(desktopMain.includes("unpackedAsset('assets', 'tray.ico')"), 'Windows 桌面托盘未使用多尺寸 ICO')
requireText(!desktopMain.includes("unpackedAsset('assets', 'icon.png')"), '桌面入口仍保留旧 icon.png 兜底')

const windowsGenerator = read('scripts/prepare-windows-icon.ps1')
requireText(windowsGenerator.includes('@(16, 20, 24, 32, 40, 48, 64, 128, 256)'), '应用 ICO 尺寸矩阵不完整')
requireText(windowsGenerator.includes('@(16, 20, 24, 32, 40, 48)'), '托盘 ICO 尺寸矩阵不完整')
requireText(windowsGenerator.includes('#005DFF') && windowsGenerator.includes('#00DDE4'), 'Windows 派生器仍使用旧品牌底色')
requireText(windowsGenerator.includes('#FFB10F') && windowsGenerator.includes('#FF7B20'), 'Windows 派生器缺少新橙色焦点')
requireText(windowsGenerator.includes('1254'), 'Windows 派生器未按新 1254 主母版坐标系同步')

const macGenerator = read('scripts/prepare-macos-icon.sh')
for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
  requireText(macGenerator.includes(`make_icon ${size}`), `macOS ICNS 派生器缺少 ${size}px 图标`)
}
requireText(macGenerator.includes('iconutil -c icns'), 'macOS 派生器未生成正式 ICNS')

const gitignore = read('.gitignore')
for (const asset of ['icon-app.ico', 'icon-window.png', 'tray.ico']) {
  requireText(gitignore.includes(`apps/desktop/assets/${asset}`), `Windows 生成资产未加入 .gitignore：${asset}`)
}
requireText(gitignore.includes('apps/desktop/build/icon.icns'), 'macOS 生成 ICNS 未加入 .gitignore')

console.log('AgentLens 品牌图标检查通过：新主母版已同步到 Web、最新版原型与 Windows/macOS/Linux 桌面派生链。')
