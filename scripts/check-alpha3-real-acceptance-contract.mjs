import { readFileSync } from 'node:fs'

const pi = readFileSync('scripts/acceptance/pi-live-real.mjs', 'utf8')
const desktop = readFileSync('scripts/acceptance/task-center-desktop.mjs', 'utf8')
const soak = readFileSync('scripts/acceptance/task-center-resource-soak.mjs', 'utf8')
const round = readFileSync('packages/web/src/features/TaskRound.tsx', 'utf8')
const message = readFileSync('packages/web/src/features/TaskMessage.tsx', 'utf8')
const thinking = readFileSync('packages/web/src/features/TaskThinking.tsx', 'utf8')
const toolGroup = readFileSync('packages/web/src/features/TaskToolGroup.tsx', 'utf8')
const toolRow = readFileSync('packages/web/src/features/TaskToolRow.tsx', 'utf8')
const toolModel = readFileSync('packages/web/src/features/task-detail-model.ts', 'utf8')
const toolIcon = readFileSync('packages/web/src/components/ToolKindIcon.tsx', 'utf8')
const toolCss = readFileSync('packages/web/src/task-execution.css', 'utf8')
const piTaskRound = readFileSync('packages/web/src/features/PiLiveTaskRound.tsx', 'utf8')
const piHistory = readFileSync('packages/web/src/features/pi-live-history.ts', 'utf8')
const mainEntry = readFileSync('packages/web/src/main.tsx', 'utf8')
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

/* 11–13 · 真实桌面验收必须检查主视口、字体、四列、默认展开与局部输出。 */
requireText(desktop, /width: 1280, height: 800/, '桌面验收必须覆盖 1280×800')
requireText(desktop, /width: 1366, height: 768/, '桌面验收必须覆盖 1366×768')
requireText(desktop, /themes = \['light', 'dark'\]/, '桌面验收必须覆盖明暗主题')
requireText(desktop, /\.task-center-scroll/, '桌面验收必须检查左侧任务列表滚动根')
requireText(desktop, /\.review-reader-pane/, '桌面验收必须检查 Review 详情滚动根')
requireText(desktop, /\.pi-live-document/, '桌面验收必须检查 Pi Live 详情滚动根')
requireText(desktop, /documentScrollHeight > value\.innerHeight/, '桌面验收必须拒绝全局纵向滚动')
requireText(desktop, /任务列表与详情发生重叠/, '桌面验收必须检查左右区域重叠')
requireText(desktop, /closedToolGroupCount/, '桌面验收必须检查 Tool Group 初始默认展开')
requireText(desktop, /toolGridColumnCount/, '桌面验收必须检查 Tool Row 桌面四列')
requireText(desktop, /toolActionFont/, '桌面验收必须检查 Tool 核心事实字号')
requireText(desktop, /userMessageFont/, '桌面验收必须检查对话正文 14px 基线')
requireText(desktop, /thinkingFont/, '桌面验收必须检查 Thinking 正文 13px 基线')
requireText(desktop, /liveOutputOverflowY/, '桌面验收必须检查 Pi Running 输出局部滚动')
requireText(desktop, /closedErrorOutputCount/, '桌面验收必须检查错误 Tool 输出默认展开')
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

/* 08 · Thinking：原型默认展开，用户主动折叠状态保留。 */
requireText(thinking, /defaultExpanded\s*=\s*true/, 'Thinking 必须按原型默认展开，用户可主动折叠')
requireText(thinking, /useState\(defaultExpanded\)/, 'Thinking 必须保存用户主动折叠状态')
requireText(thinking, /thinking-node agent-lane-node/, 'Thinking 必须保持原型执行轨节点层级')
requireText(thinking, /thinking-label thinking-title/, 'Thinking 必须保持原型标题层级')
requireText(thinking, /thinking-preview node-preview/, 'Thinking 必须保留原型弱预览层级')
requireText(thinking, /thinking-content thinking-body/, 'Thinking 正文必须保持原型执行轨结构')

/* 01–07 · Tool：每次调用都是事实，默认展开、四列、语义徽章、Payload 下钻。 */
requireText(toolGroup, /defaultExpanded\s*=\s*true/, 'Tool Group 必须默认展开')
requireText(toolGroup, /useState\(defaultExpanded\)/, 'Tool Group 必须保存用户主动折叠状态')
requireText(toolGroup, /tool-group agent-lane-node/, 'Tool Group 必须保持原型执行轨节点层级')
requireText(toolGroup, /className="tool-title"/, 'Tool Group 标题必须保持原型 tool-title 结构')
requireText(toolGroup, /className="node-preview"/, 'Tool Group 必须保留原型执行序列摘要')
requireText(toolGroup, /className="tool-counts"/, 'Tool Group 必须保留原型调用计数')
requireText(toolGroup, /model\.tools\.map/, 'Tool Group 必须逐条渲染每一次 Tool Call')
requireText(toolGroup, /executionSequence/, 'Tool Group 摘要必须从真实 Tool Call 序列生成')
if (/errorsOnly|execution-group-toolbar/.test(toolGroup)) failures.push('Tool Group 不得恢复“只看错误/汇总工具栏”替代主执行轨')

requireText(toolRow, /data-tool-fact="true"/, '每一条 Tool Row 必须标记为可见事实')
requireText(toolRow, /tool-kind tool-kind-\$\{visualKind\}/, 'Tool Row 必须使用最终语义类型徽章')
requireText(toolRow, /className="tool-action"/, 'Tool Row 必须保留操作名称列')
requireText(toolRow, /className="tool-target"/, 'Tool Row 必须保留目标/路径/命令列')
requireText(toolRow, /tool-status/, 'Tool Row 必须保留状态与耗时列')
requireText(toolRow, /className="tool-payload"/, 'Tool Payload 必须下钻到 Tool Call 主行之外')
requireText(toolRow, /startedAtMs/, 'Running Tool 必须支持持续耗时显示')
requireText(toolModel, /'test'/, '共享 Tool Kind 必须包含测试类语义')
requireText(toolModel, /durationMs\?: number/, '共享 Tool Model 必须支持真实耗时')
requireText(toolModel, /startedAtMs\?: number/, '共享 Tool Model 必须支持 Running 起始时间')
requireText(toolIcon, /kind === 'test'/, '测试类 Tool 必须有稳定语义图标')
requireText(toolIcon, /return 'tool'/, '未知 Tool 必须有中性降级语义')

requireText(piHistory, /durationMs\?: number/, 'Pi History Tool 必须保留可推导耗时')
requireText(piHistory, /elapsedMs\(at, paired\.at\)/, 'Pi History 必须用 Tool Call / Result 时间推导耗时')
requireText(piTaskRound, /className="tool-live-output"/, 'Pi Running 必须显示有限高度实时输出预览')
requireText(piTaskRound, /open=\{tool\.status === 'error'\}/, '错误 Tool 输出必须默认展开')
requireText(piTaskRound, /startedAtMs/, 'Pi Running Tool 必须保留本轮起始时间以显示持续耗时')
const explicitPiExpanded = piTaskRound.match(/defaultExpanded/g) ?? []
if (explicitPiExpanded.length < 4) failures.push('Pi History / Running 的 Thinking 与 Tool Group 必须显式保持原型默认展开')

/* 09–12 · Round / Message / Execution 三层视觉与明暗响应式基线。 */
requireText(round, /className={`task-round interaction-block/, 'Round 必须使用原型 task-round 轻边界结构')
requireText(round, /round-label/, 'Round 必须保留原型 label 结构')
requireText(round, /round-preview/, 'Round 必须保留原型 preview 结构')
requireText(round, /round-meta/, 'Round 必须保留原型 meta 结构')
requireText(message, /message-row .*user/, '用户消息必须保留原型右侧 message-row 结构')
requireText(message, /message-row .*agent/, 'Agent 消息必须保留原型左侧 message-row 结构')
requireText(message, /task-message-agent-mark/, 'Agent 消息必须使用弱引导标记而不是抢视觉头像')

requireText(toolCss, /grid-template-columns:\s*76px\s+minmax\(94px,\s*auto\)\s+minmax\(0,\s*1fr\)\s+auto/, '桌面 Tool Row 必须保持原型四列：类型 / 操作 / 目标 / 状态耗时')
requireText(toolCss, /font:\s*650 13px\/1\.4/, 'Tool 操作名称必须保持至少 13px 核心事实字号')
requireText(toolCss, /tool-target[\s\S]*font-size:\s*13px/, 'Tool 目标必须保持 13px 主阅读字号')
requireText(toolCss, /task-message-content[\s\S]*font-size:\s*14px/, '对话正文必须保持 14px 基线')
requireText(toolCss, /thinking-content[\s\S]*font-size:\s*13px/, 'Thinking 正文必须保持 13px 基线')
requireText(toolCss, /min-height:\s*38px/, 'Tool Row 必须保持原型 38px 紧凑行高')
requireText(toolCss, /tool-kind-test/, '测试类 Tool 必须有语义色而不是突兀通用占位')
requireText(toolCss, /tool-kind-tool/, '未知 Tool 必须有中性降级视觉')
requireText(toolCss, /:root\[data-theme='dark'\][\s\S]*tool-kind-test/, 'Dark 主题必须保留 Tool 语义色')
requireText(toolCss, /tool-live-output[\s\S]*max-height:\s*112px[\s\S]*overflow:\s*auto/, 'Pi Running 输出必须有限高度并局部滚动')
requireText(toolCss, /focus-visible/, 'Tool Row 必须有键盘 Focus 表现')
requireText(toolCss, /@media \(max-width: 1199\.98px\)/, 'Tool Row 必须覆盖固定 lg 降级')
requireText(toolCss, /@media \(max-width: 991\.98px\)/, 'Tool Row 必须覆盖紧凑桌面降级')
requireText(toolCss, /@media \(max-width: 767\.98px\)/, 'Tool Row 必须覆盖窄视口降级')
requireText(toolCss, /prefers-reduced-motion/, '非必要折叠动效必须尊重 reduced motion')
if (/!important/.test(toolCss)) failures.push('Task Detail 最终表现层不得新增 !important 层叠污染')

const taskCenterImport = mainEntry.indexOf("import './task-center.css'")
const taskExecutionImport = mainEntry.indexOf("import './task-execution.css'")
if (taskCenterImport < 0 || taskExecutionImport < 0 || taskExecutionImport <= taskCenterImport) {
  failures.push('task-execution.css 必须作为 Task Detail 最终表现层加载在 task-center.css 之后')
}

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
console.log('alpha.3 真实验收入口检查通过：Task Detail 高保真 01–14、真实 Pi、1280/1366 明暗桌面、独立滚动、四列 Tool、Thinking/Tool 默认展开、Running 局部输出、100 次任务切换与 1h/8h 资源趋势均已锁定。')
