import { readFileSync } from 'node:fs'

const pi = readFileSync('scripts/acceptance/pi-live-real.mjs', 'utf8')
const desktop = readFileSync('scripts/acceptance/task-center-desktop.mjs', 'utf8')
const soak = readFileSync('scripts/acceptance/task-center-resource-soak.mjs', 'utf8')
const toolGroup = readFileSync('packages/web/src/features/TaskToolGroup.tsx', 'utf8')
const toolRow = readFileSync('packages/web/src/features/TaskToolRow.tsx', 'utf8')
const toolCss = readFileSync('packages/web/src/task-execution.css', 'utf8')
const piTaskRound = readFileSync('packages/web/src/features/PiLiveTaskRound.tsx', 'utf8')
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
requireText(desktop, /clickTaskSequence\(win, 100\)/, '桌面验收必须覆盖 100 次真实任务切换')
requireText(desktop, /Memory\.getDOMCounters/, '百次切换必须采集 DOM / Listener 前后趋势')
requireText(desktop, /listenerGrowth > 20/, '百次切换必须限制 Listener 持续增长')

requireText(soak, /Performance\.getMetrics/, '长时验收必须采集 Chromium Performance metrics')
requireText(soak, /Memory\.getDOMCounters/, '长时验收必须采集 DOM counters')
requireText(soak, /jsEventListeners/, '长时验收必须采集事件 Listener 数')
requireText(soak, /JSHeapUsedSize/, '长时验收必须采集 JS Heap')
requireText(soak, /residentSet/, '长时验收必须采集 Renderer RSS')
requireText(soak, /percentCPUUsage/, '长时验收必须采集 Renderer CPU')

/* Tool Call 高保真契约：原型不改，正式实现不能再把成功调用退化成摘要。 */
requireText(
  toolGroup,
  /defaultExpanded\s*=\s*true/,
  'Tool Call 是执行轨事实：工具组必须默认展开，只允许用户主动折叠，不能因成功状态默认隐藏具体调用',
)
requireText(toolGroup, /className="tool-title"/, 'Tool Group 标题必须保持原型 tool-title 结构')
requireText(toolGroup, /className="node-preview"/, 'Tool Group 必须保留原型执行序列摘要')
requireText(toolGroup, /className="tool-counts"/, 'Tool Group 必须保留原型调用计数')
requireText(toolGroup, /model\.tools\.map/, 'Tool Group 必须直接渲染每一次具体 Tool Call')
if (/errorsOnly|execution-group-toolbar/.test(toolGroup)) failures.push('Tool Group 不得恢复“只看错误/汇总工具栏”来替代原型执行轨')

requireText(toolRow, /tool-kind tool-kind-\$\{model\.kind\}/, 'Tool Row 必须保留语义类型徽章')
requireText(toolRow, /className="tool-action"/, 'Tool Row 必须保留操作名称列')
requireText(toolRow, /className="tool-target"/, 'Tool Row 必须保留目标/路径/命令列')
requireText(toolRow, /tool-status/, 'Tool Row 必须保留状态与耗时列')
requireText(toolRow, /className="tool-payload"/, 'Tool Payload 必须下钻到 Tool Call 主行之外')

requireText(
  toolCss,
  /grid-template-columns:\s*76px\s+minmax\(94px,\s*auto\)\s+minmax\(0,\s*1fr\)\s+auto/,
  '桌面 Tool Row 必须保持原型四列：类型 / 操作 / 目标 / 状态耗时',
)
requireText(toolCss, /min-height:\s*38px/, 'Tool Row 必须保持原型 38px 紧凑行高')
requireText(toolCss, /@media \(max-width: 1199\.98px\)/, 'Tool Row 必须覆盖 1280/1366 主桌面基线的响应式收敛')
requireText(toolCss, /@media \(max-width: 991\.98px\)/, 'Tool Row 必须覆盖紧凑桌面降级')
requireText(toolCss, /@media \(max-width: 767\.98px\)/, 'Tool Row 必须覆盖窄视口降级')

const explicitPiExpanded = piTaskRound.match(/defaultExpanded/g) ?? []
if (explicitPiExpanded.length < 2) failures.push('Pi History 与 Pi Running 必须都显式锁定 Tool Group 默认展开')

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
console.log('alpha.3 真实验收入口检查通过：真实 Pi 全链路/1h soak、1280/1366 明暗桌面、独立滚动、Tool Call 默认可见与四列执行轨、Review/Pi 共用行为、100 次任务切换、1h/8h 资源趋势均已锁定。')
