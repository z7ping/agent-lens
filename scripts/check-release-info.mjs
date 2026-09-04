import { readFileSync } from 'node:fs'

const appPath = 'packages/web/src/App.tsx'
const sidebarPath = 'packages/web/src/components/WorkspaceSidebar.tsx'
const mainPath = 'packages/web/src/main.tsx'
const releaseInfoPath = 'packages/web/src/components/ReleaseInfo.tsx'
const releaseCssPath = 'packages/web/src/release-info.css'
const webUpdatePath = 'packages/web/src/client/update.ts'
const packagePath = 'packages/web/package.json'
const changelogPath = 'CHANGELOG.md'

const app = readFileSync(appPath, 'utf8')
const sidebar = readFileSync(sidebarPath, 'utf8')
const main = readFileSync(mainPath, 'utf8')
const releaseInfo = readFileSync(releaseInfoPath, 'utf8')
const css = readFileSync(releaseCssPath, 'utf8')
const webUpdate = readFileSync(webUpdatePath, 'utf8')
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
const changelog = readFileSync(changelogPath, 'utf8')

if (!app.includes("import { WorkspaceSidebar } from './components/WorkspaceSidebar'")) {
  throw new Error('正式 Web Shell 必须接入统一左侧工作栏')
}
if (!sidebar.includes("import { ReleaseInfo } from './ReleaseInfo'")) {
  throw new Error('左侧工作栏设置必须接入统一发行信息组件')
}
if (!sidebar.includes('<ReleaseInfo runtimeOwner={snapshot.health?.runtime?.owner ?? null} runtimeReady={snapshot.health !== null}/>')) {
  throw new Error('正式 Web 设置必须复用运行时健康状态，并保留版本 / 发行信息入口')
}
if (sidebar.includes('<BrandVersion />')) {
  throw new Error('版本号属于低频发行信息，不得重新常驻占用工作栏品牌区')
}
if (!main.includes("import './release-info.css'")) {
  throw new Error('正式 Web 必须加载发行信息组件样式')
}
if (!releaseInfo.includes("from '../../package.json'")) {
  throw new Error('界面版本必须来自 Web 包版本，禁止单独硬编码')
}
if (!releaseInfo.includes("from '../../../../CHANGELOG.md?raw'")) {
  throw new Error('更新日志摘要必须直接来自仓库 CHANGELOG.md，禁止维护第二份日志')
}
for (const required of ['GitHub', '更新日志', '发布记录', '完整更新日志', 'https://github.com/z7ping/agent-lens']) {
  if (!releaseInfo.includes(required)) throw new Error(`发行信息组件缺少：${required}`)
}
for (const label of ['新增', '调整', '修复', '安全', '已知限制']) {
  if (!releaseInfo.includes(`'${label}'`)) throw new Error(`发行信息组件缺少中文日志分类：${label}`)
}
if (!releaseInfo.includes('checkWebUpdate') || !releaseInfo.includes('新版本 v')) {
  throw new Error('正式 Web 设置必须保留低打扰的新版本提示')
}
if (!releaseInfo.includes('checkWebUpdate(packageMetadata.version, { runtimeOwner })')
  || !releaseInfo.includes('if (!runtimeReady) return')) {
  throw new Error('版本检查必须等待 ClientModel health，并复用已有 runtime owner，禁止 Shell 重复请求 health')
}
for (const required of [
  "owner !== 'desktop'",
  'WEB_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000',
  "installCommand: 'agent-lens update'",
  'npm install -g @z7ping/agent-lens@',
]) {
  if (!webUpdate.includes(required)) throw new Error(`Web 更新检查缺少契约：${required}`)
}
if (!webUpdate.includes("fetchImpl('/api/v1/health'")
  || !webUpdate.includes('options.runtimeOwner === undefined ? await fetchRuntimeOwner(fetchImpl) : options.runtimeOwner')) {
  throw new Error('Web 更新检查必须保留独立调用时的 health 回退，同时允许 Shell 注入已有运行时归属')
}
if (!changelog.includes(`## ${packageJson.version}`)) {
  throw new Error(`CHANGELOG.md 缺少当前 Web 版本 ${packageJson.version} 的章节`)
}
if (!css.includes('AgentLens 1.0 发行信息组件正式样式')) {
  throw new Error('release-info.css 必须明确作为发行信息组件正式样式所有者')
}
const tooSmall = [...css.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px\b/g)]
  .map(match => Number(match[1]))
  .filter(value => value > 0 && value < 12)
if (tooSmall.length) {
  throw new Error(`发行信息组件出现小于 12px 的字号：${[...new Set(tooSmall)].join(', ')}px`)
}
if (!css.includes('@media (max-width: 820px)') || !css.includes('.header-link-github')) {
  throw new Error('发行信息组件必须保留窄屏入口收口规则')
}

console.log(`发行信息界面检查通过：v${packageJson.version}`)