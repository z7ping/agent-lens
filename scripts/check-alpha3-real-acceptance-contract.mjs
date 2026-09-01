import { readFileSync } from 'node:fs'

const pi = readFileSync('scripts/acceptance/pi-live-real.mjs', 'utf8')
const desktop = readFileSync('scripts/acceptance/task-center-desktop.mjs', 'utf8')
const soak = readFileSync('scripts/acceptance/task-center-resource-soak.mjs', 'utf8')
const realSmokeWorkflow = readFileSync('.github/workflows/alpha3-task-center-real-smoke.yml', 'utf8')
const round = readFileSync('packages/web/src/features/TaskRound.tsx', 'utf8')
const message = readFileSync('packages/web/src/features/TaskMessage.tsx', 'utf8')
const thinking = readFileSync('packages/web/src/features/TaskThinking.tsx', 'utf8')
const toolGroup = readFileSync('packages/web/src/features/TaskToolGroup.tsx', 'utf8')
const toolRow = readFileSync('packages/web/src/features/TaskToolRow.tsx', 'utf8')
const toolModel = readFileSync('packages/web/src/features/task-detail-model.ts', 'utf8')
const toolIcon = readFileSync('packages/web/src/components/ToolKindIcon.tsx', 'utf8')
const taskExecutionCss = readFileSync('packages/web/src/task-execution.css', 'utf8')
const prototypeCss = readFileSync('packages/web/src/task-detail-prototype.css', 'utf8')
const polishCss = readFileSync('packages/web/src/task-detail-polish.css', 'utf8')
const toolCss = `${taskExecutionCss}\n${prototypeCss}\n${polishCss}`
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

/* 11–13 · 真实桌面：两个主视口、明暗主题、独立滚动、初始事实可见、字号与局部输出。 */
requireText(desktop, /width: 1280, height: 800/, '桌面验收必须覆盖 1280×800')
requireText(desktop, /width: 1366, height: 768/, '桌面验收必须覆盖 1366×768')
requireText(desktop, /themes = \['light', 'dark'\]/, '桌面验收必须覆盖明暗主题')
requireText(desktop, /Emulation\.setDeviceMetricsOverride/, '桌面验收必须用 Chromium Device Metrics 锁定 CSS viewport，不能依赖 hosted runner 物理窗口大小')
requireText(desktop, /deviceScaleFactor:\s*1/, '桌面验收必须锁定 deviceScaleFactor=1')
requireText(desktop, /Page\.captureScreenshot/, '桌面验收必须按 emulated viewport 保存真实 Chromium 截图')
requireText(desktop, /captureBeyondViewport:\s*false/, '桌面截图不得越过当前目标 viewport')
requireText(desktop, /safeDetachDebugger/, '桌面验收必须处理 Window teardown 与 debugger detach 竞态')
requireText(desktop, /viewport 几何未稳定到原型基线/, '桌面截图前必须等待 viewport / dvh / Rail 几何稳定')
requireText(desktop, /\.task-center-scroll/, '桌面验收必须检查左侧任务列表滚动根')
requireText(desktop, /\.review-reader-pane/, '桌面验收必须检查 Review 详情滚动根')
requireText(desktop, /\.pi-live-document/, '桌面验收必须检查 Pi Live 详情滚动根')
requireText(desktop, /documentScrollHeight > value\.innerHeight/, '桌面验收必须拒绝全局纵向滚动')
requireText(desktop, /任务列表与详情发生重叠/, '桌面验收必须检查左右区域重叠')
requireText(desktop, /hiddenToolFactCount/, '桌面验收必须检查初始 Tool Call 事实可见')
requireText(desktop, /toolGridColumnCount/, '桌面验收必须检查 Tool Row 桌面四列')
requireText(desktop, /toolRowScrollWidth/, '桌面验收必须拒绝 Tool Row 横向溢出')
requireText(desktop, /toolActionFont/, '桌面验收必须检查 Tool 核心事实字号')
requireText(desktop, /userMessageFont/, '桌面验收必须检查对话正文 14px 基线')
requireText(desktop, /thinkingFont/, '桌面验收必须检查 Thinking 正文 13px 基线')
requireText(desktop, /liveOutputOverflowY/, '桌面验收必须检查 Pi Running 输出局部滚动')
requireText(desktop, /closedErrorOutputCount/, '桌面验收必须检查错误 Tool 输出默认展开')
requireText(desktop, /runInspectorReturn/, '桌面验收必须覆盖 Tool 行点击打开右侧 Inspector 并恢复焦点/滚动')
requireText(desktop, /clickTaskSequence\(win, 100\)/, '桌面验收必须覆盖 100 次真实组件任务切换')
requireText(desktop, /Memory\.getDOMCounters/, '百次切换必须采集 DOM / Listener 前后趋势')
requireText(desktop, /listenerGrowth > 20/, '百次切换必须限制 Listener 持续增长')

/* Real Smoke 不能用空 DB 或假 DOM 冒充真实组件链路：必须经 Source → Observation → Review Projection 注入确定性样本。 */
requireText(realSmokeWorkflow, /CODEX_HOME/, 'Real Smoke 必须隔离并注入确定性 Codex Home')
requireText(realSmokeWorkflow, /AGENT_LENS_ENABLED_SOURCES = 'codex'/, 'Real Smoke 必须显式启用 Codex Capture Policy，不能让默认 claude-code 策略吞掉 fixture')
requireText(realSmokeWorkflow, /codex-sample\.jsonl/, 'Real Smoke 必须复用项目自身 Codex fixture')
requireText(realSmokeWorkflow, /api\/v1\/review\?limit=10/, 'Real Smoke 必须等待正式 Review Projection 数据就绪')
requireText(realSmokeWorkflow, /Count -ge 2/, 'Real Smoke 至少需要两条正式投影任务，确保百次切换不跳过')
requireText(realSmokeWorkflow, /value\.toolCount -lt 1/, 'Real Smoke 必须拒绝没有 Tool Call 的 viewport/theme case')
requireText(realSmokeWorkflow, /switchStability\.skipped/, 'Real Smoke 必须拒绝 100 次任务切换被跳过')
requireText(realSmokeWorkflow, /completedSwitches -ne 100/, 'Real Smoke 必须确认完整执行 100 次任务切换')

requireText(soak, /Performance\.getMetrics/, '长时验收必须采集 Chromium Performance metrics')
requireText(soak, /Memory\.getDOMCounters/, '长时验收必须采集 DOM counters')
requireText(soak, /jsEventListeners/, '长时验收必须采集事件 Listener 数')
requireText(soak, /JSHeapUsedSize/, '长时验收必须采集 JS Heap')
requireText(soak, /residentSet/, '长时验收必须采集 Renderer RSS')
requireText(soak, /percentCPUUsage/, '长时验收必须采集 Renderer CPU')

/* Thinking：默认展开，允许用户主动折叠，使用稳定 disclosure 图标。 */
requireText(thinking, /defaultExpanded\s*=\s*true/, 'Thinking 必须按原型默认展开')
requireText(thinking, /useState\(defaultExpanded\)/, 'Thinking 必须保存用户主动折叠状态')
requireText(thinking, /thinking-node agent-lane-node/, 'Thinking 必须保持执行轨节点层级')
requireText(thinking, /thinking-preview node-preview/, 'Thinking 必须保留弱预览层级')
requireText(thinking, /thinking-content/, 'Thinking 正文必须保持执行轨结构')
requireText(thinking, /disclosure-chevron thinking-chevron/, 'Thinking 必须使用统一 SVG disclosure 图标')

/* Tool：最终原型取消 Tool Group 自身折叠；事实行直接可见，真实父关系决定是否跟随 Thinking 折叠。 */
requireText(toolGroup, /data-task-tool-group="true"/, 'Tool Group 必须保留稳定语义边界')
requireText(toolGroup, /model\.tools\.map/, 'Tool Group 必须逐条渲染每一次 Tool Call')
if (/<details[\s\S]*data-task-tool-group="true"/.test(toolGroup)) failures.push('Tool Group 不得恢复独立 details 折叠层；只允许跟随真实 Thinking 父级折叠')
if (/errorsOnly|execution-group-toolbar/.test(toolGroup)) failures.push('Tool Group 不得恢复“只看错误/汇总工具栏”替代主执行轨')

requireText(toolRow, /data-tool-fact="true"/, '每一条 Tool Row 必须标记为 Tool Call 事实')
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
requireText(piHistory, /elapsedMs\(fact\.at, paired\.at\)/, 'Pi History 必须用 Tool Call / Result 时间推导耗时')
requireText(piTaskRound, /className="tool-live-output"/, 'Pi Running 必须显示有限高度实时输出预览')
requireText(piTaskRound, /open=\{tool\.status === 'error'\}/, '错误 Tool 输出必须默认展开')
requireText(piTaskRound, /startedAtMs/, 'Pi Running Tool 必须保留本轮起始时间以显示持续耗时')
const explicitThinkingExpanded = piTaskRound.match(/<TaskThinking[^>]*defaultExpanded/g) ?? []
if (explicitThinkingExpanded.length < 2) failures.push('Pi History / Running Thinking 必须显式保持默认展开')

/* 三层视觉、字体、响应式、主题。 */
requireText(round, /task-round interaction-block/, 'Round 必须使用轻边界结构')
requireText(round, /round-label/, 'Round 必须保留 label')
requireText(round, /round-preview/, 'Round 必须保留 preview')
requireText(round, /round-meta/, 'Round 必须保留 meta')
requireText(round, /disclosure-chevron interaction-chevron/, 'Round 必须使用统一 SVG disclosure 图标')
requireText(message, /message-row/, '消息必须使用 message-row 主结构')
requireText(message, /message-row \$\{user \? 'user' : 'agent'\} task-message-row/, '消息必须用 TaskMessage 自有 user / agent 结构表达左右方向')
if (/task-message-agent-mark/.test(message)) failures.push('Agent 正文不得恢复额外 AI 引导图标；完整智能体轮次由文档流表达')
if (/chat-row message-row|chat-avatar chat-avatar-agent/.test(message)) failures.push('TaskMessage 不得重新挂载会污染 flex 方向或隐藏 Agent 节点的旧 Review 表现类')

requireText(toolCss, /execution-group > summary,[\s\S]*tool-group > summary \{ display: none;/, 'Tool Group 标题必须在最终原型中隐藏')
requireText(toolCss, /grid-template-columns:\s*66px\s+auto\s+minmax\(88px,\s*auto\)\s+minmax\(0,\s*1fr\)/, '桌面 Tool Row 必须保持四列紧凑事实布局')
requireText(toolCss, /font:\s*650 13px\/1\.4/, 'Tool 操作名称必须保持 13px 主阅读字号')
requireText(toolCss, /tool-target[\s\S]*font-size:\s*13px/, 'Tool 目标必须保持 13px 主阅读字号')
requireText(toolCss, /task-message-content[\s\S]*font-size:\s*14px/, '对话正文必须保持 14px 基线')
requireText(toolCss, /thinking-content[\s\S]*font-size:\s*13px/, 'Thinking 正文必须保持 13px 基线')
requireText(toolCss, /min-height:\s*30px/, 'Tool Row 必须保持约 30px 紧凑行高')
requireText(toolCss, /tool-kind-test/, '测试类 Tool 必须有语义色')
requireText(toolCss, /tool-kind-tool/, '未知 Tool 必须有中性降级视觉')
requireText(toolCss, /:root\[data-theme='dark'\][\s\S]*tool-kind-test/, 'Dark 主题必须保留 Tool 语义色')
requireText(toolCss, /tool-live-output[\s\S]*max-height:\s*112px[\s\S]*overflow:\s*auto/, 'Pi Running 输出必须有限高度并局部滚动')
requireText(toolCss, /focus-visible/, 'Tool Row 必须有键盘 Focus 表现')
requireText(toolCss, /@media \(max-width: 1199\.98px\)/, 'Tool Row 必须覆盖固定 lg 降级')
requireText(toolCss, /@media \(max-width: 991\.98px\)/, 'Tool Row 必须覆盖紧凑桌面降级')
requireText(toolCss, /@media \(max-width: 767\.98px\)/, 'Tool Row 必须覆盖窄视口降级')
requireText(toolCss, /prefers-reduced-motion/, '非必要动效必须尊重 reduced motion')
if (/!important/.test(polishCss)) failures.push('Task Detail 最终收口层不得新增 !important 层叠污染')

/* task-center.css 只持有壳层；Task Detail 由 execution → prototype → polish 逐层收口。 */
if (/\.task-center-main \.execution-row|\.task-center-main \.thinking-block|\.execution-group-toolbar/.test(taskCenterCss)) {
  failures.push('task-center.css 不得继续复制 Thinking / Tool 执行轨样式')
}
const taskCenterImport = mainEntry.indexOf("import './task-center.css'")
const taskExecutionImport = mainEntry.indexOf("import './task-execution.css'")
const prototypeImport = mainEntry.indexOf("import './task-detail-prototype.css'")
const polishImport = mainEntry.indexOf("import './task-detail-polish.css'")
if (taskCenterImport < 0 || taskExecutionImport <= taskCenterImport || prototypeImport <= taskExecutionImport || polishImport <= prototypeImport) {
  failures.push('Task Detail 样式加载顺序必须保持 task-center → task-execution → task-detail-prototype → task-detail-polish')
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
console.log('alpha.3 Checklist 实现契约已锁定：Thinking 自身折叠、Tool Call 直接可见并仅按真实父关系跟随 Thinking、Tool 行点击 Inspector、Agent 文档流、1280/1366 明暗桌面、精确 Chromium viewport、确定性 Review 正式投影、独立滚动、真实 Pi、Running 局部输出、100 次任务切换与 1h/8h 资源趋势均有对应验收入口。')
