import { readFileSync } from 'node:fs'

const pi = readFileSync('scripts/acceptance/pi-live-real.mjs', 'utf8')
const desktop = readFileSync('scripts/acceptance/task-center-desktop.mjs', 'utf8')
const soak = readFileSync('scripts/acceptance/task-center-resource-soak.mjs', 'utf8')
const pkg = readFileSync('package.json', 'utf8')
const failures = []

function requireText(source, pattern, message) {
  if (!pattern.test(source)) failures.push(message)
}

for (const token of [
  '/api/v1/pi-live/availability',
  '/events',
  '/prompt',
  '/steer',
  '/follow-up',
  '/abort',
  '/snapshot',
  '/model',
  '/thinking-level',
  '/api/v1/review?limit=500',
]) {
  if (!pi.includes(token)) failures.push(`真实 Pi 验收缺少 ${token}`)
}
requireText(pi, /Abort \+ Queue Restore/, '真实 Pi 验收必须覆盖 Abort + Queue Restore')
requireText(pi, /Reconnect \+ Snapshot 恢复/, '真实 Pi 验收必须覆盖 Reconnect + Snapshot')
requireText(pi, /source-pi \/ Review 可看到同一真实会话历史/, '真实 Pi 验收必须核对历史事实回流')
requireText(pi, /runSoak/, '真实 Pi 验收必须提供长时 Streaming soak')
requireText(pi, /soak round .* settled/, '真实 Pi soak 必须逐轮确认 settled')

requireText(desktop, /width: 1280, height: 800/, '桌面验收必须覆盖 1280×800')
requireText(desktop, /width: 1366, height: 768/, '桌面验收必须覆盖 1366×768')
requireText(desktop, /themes = \['light', 'dark'\]/, '桌面验收必须覆盖明暗主题')
requireText(desktop, /\.task-center-scroll/, '桌面验收必须检查左侧任务列表滚动根')
requireText(desktop, /\.review-reader-pane/, '桌面验收必须检查 Review 详情滚动根')
requireText(desktop, /\.pi-live-document/, '桌面验收必须检查 Pi Live 详情滚动根')
requireText(desktop, /documentScrollHeight > value\.innerHeight/, '桌面验收必须拒绝全局纵向滚动')
requireText(desktop, /任务列表与详情发生重叠/, '桌面验收必须检查左右区域重叠')
requireText(desktop, /capturePage\(\)/, '桌面验收必须保存真实 Chromium 截图')

requireText(soak, /Performance\.getMetrics/, '长时验收必须采集 Chromium Performance metrics')
requireText(soak, /Memory\.getDOMCounters/, '长时验收必须采集 DOM counters')
requireText(soak, /jsEventListeners/, '长时验收必须采集事件 Listener 数')
requireText(soak, /JSHeapUsedSize/, '长时验收必须采集 JS Heap')
requireText(soak, /residentSet/, '长时验收必须采集 Renderer RSS')
requireText(soak, /percentCPUUsage/, '长时验收必须采集 Renderer CPU')

for (const script of [
  'accept:pi-live-real',
  'accept:pi-live:1h',
  'accept:task-center-desktop',
  'accept:task-center:1h',
  'accept:task-center:8h',
]) {
  if (!pkg.includes(`"${script}"`)) failures.push(`package.json 缺少 ${script} 验收命令`)
}

if (failures.length) {
  console.error('alpha.3 真实验收契约失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log('alpha.3 真实验收入口检查通过：真实 Pi 全链路/1h soak、1280/1366 明暗桌面、独立滚动、1h/8h 资源趋势均已锁定。')
