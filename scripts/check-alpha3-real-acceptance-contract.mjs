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
const taskCenterCss = readFileSync('packages/web/src/task-center.css', 'utf8')
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

/* 11–13 · 真实桌面：两个主视口、明暗主题、独立滚动、事实可见、字号与局部输出。 */
requireText(desktop, /width: 1280, height: 800/, '桌面验收必须覆盖 1280×800')
requireText(desktop, /width: 1366, height: 768/, '桌面验收必须覆盖 1366×768')
requireText(desktop, /themes = \['light', 'dark'\]/, '桌面验收必须覆盖明暗主题')
requireText(desktop, /\.task-center-scroll/, '桌面验收必须检查左侧任务列表滚动根')
requireText(desktop, /\.review-reader-pane/, '桌面验收必须检查 Review 详情滚动根')
requireText(desktop, /\.pi-live-document/, '桌面验收必须检查 Pi Live 详情滚动根')
requireText(desktop, /documentScrollHeight > value\.innerHeight/, '桌面验收必须拒绝全局纵向滚动')
requireText(desktop, /任务列表与详情发生重叠/, '桌面验收必须检查左右区域重叠')
requireText(desktop, /collapsibleToolGroupCount/, '桌面验收必须拒绝组级折叠 Tool Call')
requireText(desktop, /hiddenToolFactCount/, '桌面验收必须拒绝不可见 Tool Call 事实')
requireText(desktop, /toolGridColumnCount/, '桌面验收必须检查 Tool Row 桌面四列')
requireText(desktop, /toolRowScrollWidth/, '桌面验收必须拒绝 Tool Row 横向溢出')
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

/* 08 · Thinking：默认展开，但允许用户主动折叠。 */
requireText(thinking, /defaultExpanded\s*=\s*true/, 'Thinking 必须按原型默认展开')
requireText(thinking, /useState\(defaultExpanded\)/, 'Thinking 必须保存用户主动折叠状态')
requireText(thinking, /thinking-node agent-lane-node/, 'Thinking 必须保持执行轨节点层级')
requireText(thinking, /thinking-preview node-preview/, 'Thinking 必须保留弱预览层级')
requireText(thinking, /thinking-content/, 'Thinking 正文必须保持执行轨结构')

/* 01–07 · Tool：Tool Call 永远可见；组摘要不得成为折叠器；Payload 单独下钻。 */
requireText(toolGroup, /<section[\s\S]*data-task-tool-group="true"/, 'Tool Group 必须使用非折叠语义容器')
requireText(toolGroup, /className="tool-group-summary"/, 'Tool Group 必须保留轻量执行序列摘要')
requireText(toolGroup, /className="tool-title"/, 'Tool Group 必须保留 tool-title')
requireText(toolGroup, /className="node-preview"/, 'Tool Group 必须保留执行序列摘要')
requireText(toolGroup, /className="tool-counts"/, 'Tool Group 必须保留调用计数')
requireText(toolGroup, /model\.tools\.map/, 'Tool Group 必须逐条渲染每一次 Tool Call')
requireText(toolGroup, /executionSequence/, 'Tool Group 摘要必须从真实 Tool Call 序列生成')
if (/useState|defaultExpanded|<details/.test(toolGroup)) failures.push('Tool Group 不得再拥有会隐藏 Tool Call 的组级折叠状态')
if (/errorsOnly|execution-group-toolbar/.test(toolGroup)) failures.push('Tool Group 不得恢复“只看错误/汇总工具栏”替代主执行轨')

requireText(toolRow, /data-tool-fact="true"/, '每一条 Tool Row 必须标记为可见事实')
requireText(toolRow, /tool-kind tool-kind-\$\{visualKind\}/, 'Tool Row 必须使用最终语义类型徽章')
requireText(toolRow, /className="tool-action"/, 'Tool Row 必须保留操作名称列')
requireText(toolRow, /className="tool-target"/, 'Tool Row 必须保留目标/路径/命令列')
requireText(toolRow, /tool-status/, 'Tool Row 必须保留状态与耗时列')
requireText(toolRow, /className="tool-payload"/, 'Tool Payload 必须位于 Tool Call 主行之外')
requireText(toolRow, /startedAtMs/, 'Running Tool 必须支持持续耗时显示')
requireText(toolModel, /durationMs\?: number/, '共享 Tool Model 必须支持真实耗时')
requireText(toolModel, /startedAtMs\?: number/, '共享 Tool Model 必须支持 Running 起始时间')
requireText(toolIcon, /kind === 'test'/, '测试类 Tool 必须有稳定语义图标')
requireText(toolIcon, /return 'tool'/, '未知 Tool 必须有中性降级语义')

requireText(piHistory, /durationMs\?: number/, 'Pi History Tool 必须保留可推导耗时')
requireText(piHistory, /elapsedMs\(at, paired\.at\)/, 'Pi History 必须用 Tool Call / Result 时间推导耗时')
requireText(piTaskRound, /className="tool-live-output"/, 'Pi Running 必须显示有限高度实时输出预览')
requireText(piTaskRound, /open=\{tool\.status === 'error'\}/, '错误 Tool 输出必须默认展开')
requireText(piTaskRound, /startedAtMs/, 'Pi Running Tool 必须保留本轮起始时间以显示持续耗时')
if (/<TaskToolGroup[\s\S]{0,180}defaultExpanded/.test(piTaskRound)) failures.push('Pi History / Running 不得重新给 Tool Group 增加组级折叠状态')
const explicitThinkingExpanded = piTaskRound.match(/<TaskThinking[^>]*defaultExpanded/g) ?? []
if (explicitThinkingExpanded.length < 2) failures.push('Pi History / Running Thinking 必须显式保持默认展开')

/* 09–12 · 三层视觉、字体、响应式、主题。 */
requireText(round, /task-round interaction-block/, 'Round 必须使用轻边界结构')
requireText(round, /round-label/, 'Round 必须保留 label')
requireText(round, /round-preview/, 'Round 必须保留 preview')
requireText(round, /round-meta/, 'Round 必须保留 meta')
requireText(message, /message-row/, '消息必须使用 message-row 主结构')
requireText(message, /chat-row-user user/, '用户消息必须保留右侧结构')
requireText(message, /chat-row-agent agent/, 'Agent 消息必须保留左侧结构')
requireText(message, /task-message-agent-mark/, 'Agent 消息必须保留弱引导标记')

requireText(toolCss, /grid-template-columns:\s*76px\s+minmax\(94px,\s*auto\)\s+minmax\(0,\s*1fr\)\s+auto/, '桌面 Tool Row 必须保持四列：类型 / 操作 / 目标 / 状态耗时')
requireText(toolCss, /font:\s*650 13px\/1\.4/, 'Tool 操作名称必须至少 13px')
requireText(toolCss, /tool-target[\s\S]*font-size:\s*13px/, 'Tool 目标必须保持 13px 主阅读字号')
requireText(toolCss, /task-message-content[\s\S]*font-size:\s*14px/, '对话正文必须保持 14px 基线')
requireText(toolCss, /thinking-content[\s\S]*font-size:\s*13px/, 'Thinking 正文必须保持 13px 基线')
requireText(toolCss, /min-height:\s*38px/, 'Tool Row 必须保持 38px 紧凑行高')
requireText(toolCss, /tool-kind-test/, '测试类 Tool 必须有语义色')
requireText(toolCss, /tool-kind-tool/, '未知 Tool 必须有中性降级视觉')
requireText(toolCss, /:root\[data-theme='dark'\][\s\S]*tool-kind-test/, 'Dark 主题必须保留 Tool 语义色')
requireText(toolCss, /tool-live-output[\s\S]*max-height:\s*112px[\s\S]*overflow:\s*auto/, 'Pi Running 输出必须有限高度并局部滚动')
requireText(toolCss, /focus-visible/, 'Tool Row 必须有键盘 Focus 表现')
requireText(toolCss, /@media \(max-width: 1199\.98px\)/, 'Tool Row 必须覆盖固定 lg 降级')
requireText(toolCss, /@media \(max-width: 991\.98px\)/, 'Tool Row 必须覆盖紧凑桌面降级')
requireText(toolCss, /@media \(max-width: 767\.98px\)/, 'Tool Row 必须覆盖窄视口降级')
requireText(toolCss, /prefers-reduced-motion/, '非必要动效必须尊重 reduced motion')
if (/!important/.test(toolCss)) failures.push('Task Detail 最终表现层不得新增 !important 层叠污染')

/* 14 · task-center.css 只持有壳层，不能再复制执行轨样式。 */
if (/\.task-center-main \.execution-row|\.task-center-main \.thinking-block|\.execution-group-toolbar/.test(taskCenterCss)) {
  failures.push('task-center.css 不得继续复制 Thinking / Tool 执行轨样式；统一由 task-execution.css 持有')
}
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
console.log('alpha.3 Checklist 01–14 实现契约已锁定：Tool Call 永久可见、Payload 下钻、Round/Message/Execution 三层视觉、1280/1366 明暗桌面、独立滚动、真实 Pi、Running 局部输出、100 次任务切换与 1h/8h 资源趋势均有对应验收入口。')
