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
const taskDetailCss = readFileSync('packages/web/src/task-detail.css', 'utf8')
const taskCenterCss = readFileSync('packages/web/src/task-center.css', 'utf8')
const piCss = readFileSync('packages/web/src/pi-live.css', 'utf8')
const piTaskRound = readFileSync('packages/web/src/features/PiLiveTaskRound.tsx', 'utf8')
const piHistory = readFileSync('packages/web/src/features/pi-live-history.ts', 'utf8')
const mainEntry = readFileSync('packages/web/src/main.tsx', 'utf8')
const pkg = readFileSync('package.json', 'utf8')
const failures = []

function requireText(source, pattern, message) {
  if (!pattern.test(source)) failures.push(message)
}

/* 真实 Pi：必须覆盖 Runtime 生命周期、两类队列、Abort 恢复、重连和历史回流。 */
for (const token of [
  '/api/v1/pi-live/availability', '/events', '/prompt', '/steer', '/follow-up', '/abort', '/snapshot', '/model', '/thinking-level', '/api/v1/review?limit=500',
]) {
  if (!pi.includes(token)) failures.push(`真实 Pi 验收缺少 ${token}`)
}
requireText(pi, /Abort \+ Queue Restore/, '真实 Pi 验收必须覆盖 Abort + Queue Restore')
requireText(pi, /Reconnect \+ Snapshot 恢复/, '真实 Pi 验收必须覆盖 Reconnect + Snapshot')
requireText(pi, /source-pi \/ Review 可看到同一真实会话历史/, '真实 Pi 验收必须核对历史事实回流')
requireText(pi, /runSoak/, '真实 Pi 验收必须提供长时 Streaming soak')
requireText(pi, /soak round .* settled/, '真实 Pi soak 必须逐轮确认 settled')

/* 真实桌面：1280/1366、明暗主题、独立滚动、当前 Task Surface 语义类、Inspector 和百次切换。 */
requireText(desktop, /width: 1280, height: 800/, '桌面验收必须覆盖 1280×800')
requireText(desktop, /width: 1366, height: 768/, '桌面验收必须覆盖 1366×768')
requireText(desktop, /themes = \['light', 'dark'\]/, '桌面验收必须覆盖明暗主题')
requireText(desktop, /Emulation\.setDeviceMetricsOverride/, '桌面验收必须锁定 Chromium CSS viewport')
requireText(desktop, /deviceScaleFactor:\s*1/, '桌面验收必须锁定 deviceScaleFactor=1')
requireText(desktop, /Page\.captureScreenshot/, '桌面验收必须保存真实 Chromium 截图')
requireText(desktop, /captureBeyondViewport:\s*false/, '桌面截图不得越过目标 viewport')
requireText(desktop, /safeDetachDebugger/, '桌面验收必须处理 Window teardown / debugger detach 竞态')
requireText(desktop, /viewport 几何未稳定到原型基线/, '截图前必须等待 viewport / dvh / Rail 几何稳定')
for (const selector of ['.task-center-scroll', '.review-reader-pane', '.pi-live-reader', '.task-tool-row', '.task-tool-action', '.task-tool-target', '.task-tool-status', '.task-thinking-content', '.task-tool-live-output pre', '.task-tool-output-details']) {
  if (!desktop.includes(selector)) failures.push(`桌面验收仍未使用当前 Task Surface 选择器：${selector}`)
}
if (/\.tool-row|\.tool-action|\.tool-target|\.tool-status|\.thinking-content|\.tool-live-output|\.tool-output-details/.test(desktop.replaceAll('.task-tool-row', '').replaceAll('.task-tool-action', '').replaceAll('.task-tool-target', '').replaceAll('.task-tool-status', '').replaceAll('.task-thinking-content', '').replaceAll('.task-tool-live-output', '').replaceAll('.task-tool-output-details', ''))) {
  failures.push('桌面验收不得继续依赖已退役的旧 Tool / Thinking 表现类')
}
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
requireText(desktop, /runInspectorReturn/, '桌面验收必须覆盖 Tool Inspector 打开、焦点与滚动恢复')
requireText(desktop, /clickTaskSequence\(win, 100\)/, '桌面验收必须覆盖 100 次任务切换')
requireText(desktop, /Memory\.getDOMCounters/, '百次切换必须采集 DOM / Listener 趋势')
requireText(desktop, /listenerGrowth > 20/, '百次切换必须限制 Listener 持续增长')

/* Real Smoke 必须经 Source → Observation → Review Projection 注入确定性样本。 */
requireText(realSmokeWorkflow, /CODEX_HOME/, 'Real Smoke 必须隔离并注入确定性 Codex Home')
requireText(realSmokeWorkflow, /AGENT_LENS_ENABLED_SOURCES = 'codex'/, 'Real Smoke 必须显式启用 Codex Capture Policy')
requireText(realSmokeWorkflow, /codex-sample\.jsonl/, 'Real Smoke 必须复用项目 Codex fixture')
requireText(realSmokeWorkflow, /api\/v1\/review\?limit=10/, 'Real Smoke 必须等待正式 Review Projection 数据就绪')
requireText(realSmokeWorkflow, /Count -ge 2/, 'Real Smoke 至少需要两条正式投影任务')
requireText(realSmokeWorkflow, /value\.toolCount -lt 1/, 'Real Smoke 必须拒绝没有 Tool Call 的 viewport/theme case')
requireText(realSmokeWorkflow, /switchStability\.skipped/, 'Real Smoke 必须拒绝百次切换被跳过')
requireText(realSmokeWorkflow, /completedSwitches -ne 100/, 'Real Smoke 必须确认完整执行 100 次切换')

requireText(soak, /Performance\.getMetrics/, '长时验收必须采集 Chromium Performance metrics')
requireText(soak, /Memory\.getDOMCounters/, '长时验收必须采集 DOM counters')
requireText(soak, /jsEventListeners/, '长时验收必须采集事件 Listener 数')
requireText(soak, /JSHeapUsedSize/, '长时验收必须采集 JS Heap')
requireText(soak, /residentSet/, '长时验收必须采集 Renderer RSS')
requireText(soak, /percentCPUUsage/, '长时验收必须采集 Renderer CPU')

/* Thinking：单一 disclosure，默认展开，用户可主动折叠。 */
requireText(thinking, /defaultExpanded\s*=\s*true/, 'Thinking 必须默认展开')
requireText(thinking, /useState\(defaultExpanded\)/, 'Thinking 必须保存主动折叠状态')
requireText(thinking, /className={`task-thinking/, 'Thinking 必须使用共享 Task Surface 语义类')
requireText(thinking, /task-thinking-preview/, 'Thinking 必须保留弱预览')
requireText(thinking, /task-thinking-content/, 'Thinking 必须保留正文结构')
requireText(thinking, /task-disclosure-chevron task-thinking-chevron/, 'Thinking 必须复用统一 disclosure 图标')

/* Tool：Group 不产生第二折叠层；每次 Tool Call 都是直接事实行。 */
requireText(toolGroup, /data-task-tool-group="true"/, 'Tool Group 必须保留稳定语义边界')
requireText(toolGroup, /model\.tools\.map/, 'Tool Group 必须逐条渲染 Tool Call')
if (/<details[\s\S]*data-task-tool-group="true"/.test(toolGroup)) failures.push('Tool Group 不得恢复独立 details 层')
if (/errorsOnly|execution-group-toolbar/.test(toolGroup)) failures.push('Tool Group 不得恢复只看错误/汇总工具栏替代主执行轨')
requireText(toolRow, /data-tool-fact="true"/, '每条 Tool Row 必须标记 Tool Call 事实')
requireText(toolRow, /task-tool-kind task-tool-kind-\$\{visualKind\}/, 'Tool Row 必须使用语义类型')
requireText(toolRow, /className="task-tool-action"/, 'Tool Row 必须保留操作名称列')
requireText(toolRow, /className="task-tool-target"/, 'Tool Row 必须保留目标列')
requireText(toolRow, /task-tool-status/, 'Tool Row 必须保留状态/耗时列')
requireText(toolRow, /className="task-tool-payload"/, 'Tool Payload 必须位于事实行外')
requireText(toolRow, /startedAtMs/, 'Running Tool 必须支持持续耗时')
requireText(toolModel, /durationMs\?: number/, '共享 Tool Model 必须支持真实耗时')
requireText(toolModel, /startedAtMs\?: number/, '共享 Tool Model 必须支持 Running 起始时间')
requireText(toolIcon, /kind === 'test'/, '测试类 Tool 必须有稳定语义图标')
requireText(toolIcon, /return 'tool'/, '未知 Tool 必须有中性降级')

requireText(piHistory, /durationMs\?: number/, 'Pi History Tool 必须保留可推导耗时')
requireText(piHistory, /elapsedMs\(fact\.at, paired\.at\)/, 'Pi History 必须用 Call / Result 时间推导耗时')
requireText(piTaskRound, /className="task-tool-live-output"/, 'Pi Running 必须显示局部实时输出')
requireText(piTaskRound, /className="task-tool-output-details" open=\{tool\.status === 'error'\}/, '错误 Tool 输出必须默认展开')
requireText(piTaskRound, /startedAtMs/, 'Pi Running Tool 必须保留本轮起始时间')
const explicitThinkingExpanded = piTaskRound.match(/<TaskThinking[^>]*defaultExpanded/g) ?? []
if (explicitThinkingExpanded.length < 2) failures.push('Pi History / Running Thinking 必须显式默认展开')

/* Task Surface 视觉与响应式只有 task-detail.css 一个所有者。 */
requireText(round, /task-round interaction-block/, 'Round 必须保留稳定阅读锚点')
for (const cls of ['task-round-label', 'task-round-preview', 'task-round-meta', 'task-disclosure-chevron task-round-chevron']) {
  if (!round.includes(cls)) failures.push(`Round 缺少当前语义结构：${cls}`)
}
requireText(message, /task-message-row/, '消息必须使用 TaskMessage 主结构')
requireText(message, /task-message-user/, '消息必须表达用户右侧方向')
requireText(message, /task-message-assistant/, '消息必须表达 Agent 文档流方向')
if (/task-message-agent-mark|chat-avatar-agent|chat-row/.test(message)) failures.push('TaskMessage 不得恢复旧 Review 头像/方向类')

requireText(taskDetailCss, /Task Surface 共享详情组件的唯一样式所有者/, 'task-detail.css 必须声明共享详情唯一所有权')
requireText(taskDetailCss, /grid-template-columns:\s*66px auto minmax\(88px, auto\) minmax\(0, 1fr\)/, '桌面 Tool Row 必须保持四列事实布局')
requireText(taskDetailCss, /task-tool-action[^}]*font:\s*650 13px\/1\.4/s, 'Tool 操作名称必须保持 13px')
requireText(taskDetailCss, /task-tool-target[^}]*font-size:\s*13px/s, 'Tool 目标必须保持 13px')
requireText(taskDetailCss, /task-message-content[^}]*font-size:\s*14px/s, '对话正文必须保持 14px')
requireText(taskDetailCss, /task-thinking-content[^}]*font-size:\s*13px/s, 'Thinking 正文必须保持 13px')
requireText(taskDetailCss, /task-tool-row[\s\S]*min-height:\s*30px/, 'Tool Row 必须保持紧凑行高')
requireText(taskDetailCss, /task-tool-kind-test/, '测试类 Tool 必须有语义色')
requireText(taskDetailCss, /--kind-fg:\s*var\(--al-muted\)/, '未知 Tool 必须有中性降级视觉')
requireText(taskDetailCss, /task-tool-live-output pre,[\s\S]*max-height:\s*180px[\s\S]*overflow:\s*auto/, 'Pi Running 输出必须有限高度局部滚动')
requireText(taskDetailCss, /@media \(max-width: 1199\.98px\)/, 'Task Surface 必须覆盖 lg 降级')
requireText(taskDetailCss, /@media \(max-width: 991\.98px\)/, 'Task Surface 必须覆盖紧凑桌面降级')
requireText(taskDetailCss, /@media \(max-width: 767\.98px\)/, 'Task Surface 必须覆盖窄视口降级')
requireText(taskDetailCss, /prefers-reduced-motion/, '非必要动效必须尊重 reduced motion')
if (/!important/.test(taskDetailCss)) failures.push('Task Surface 唯一所有者不得使用 !important 争夺优先级')

/* Task Center 和 Pi Live 只持有自己的壳层/输入器，不能重新定义共享 Task 组件。 */
if (/\.task-(?:header|round|message|thinking|tool|event)/.test(taskCenterCss)) failures.push('task-center.css 不得复制 Task Surface 共享组件样式')
if (/\.task-(?:header|round|message|thinking|tool|event)/.test(piCss)) failures.push('pi-live.css 不得复制 Task Surface 共享组件样式')
const taskCenterImport = mainEntry.indexOf("import './task-center.css'")
const taskDetailImport = mainEntry.indexOf("import './task-detail.css'")
if (taskCenterImport < 0 || taskDetailImport <= taskCenterImport) failures.push('Task Detail 必须在页面所有者之后加载并最终接管共享 Task 组件')
for (const retired of ['task-execution.css', 'task-detail-prototype.css', 'task-detail-polish.css', 'task-feedback-polish.css', 'desktop-responsive.css']) {
  if (mainEntry.includes(retired)) failures.push(`正式入口不得恢复已退役样式层：${retired}`)
}

for (const script of ['accept:pi-live-real', 'accept:pi-live:1h', 'accept:task-center-desktop', 'accept:task-center:1h', 'accept:task-center:8h']) {
  if (!pkg.includes(`"${script}"`)) failures.push(`package.json 缺少 ${script} 验收命令`)
}

if (failures.length) {
  console.error('alpha.3 真实验收契约失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log('alpha.3 Checklist 实现契约已锁定：Task Surface 单一样式所有权、当前语义选择器、真实桌面/真实 Pi、Inspector、独立滚动、百次切换与 1h/8h 资源趋势均有对应验收入口。')
