import { readFile } from 'node:fs/promises'

const [app, taskCenter, taskSurface, taskHeader, taskMessage, taskRound, taskThinking, taskToolGroup, taskToolRow, taskDetailModel, taskCenterCss, taskDetailCss, reviewPage, page, piComposer, piTaskRound, piTaskProjection, hubPage, history, piNative, client, css, http, runtime, workerHost, workerEntry, inProcessHost, sdkLoader, sdkAdapter, runtimePackage, coreObservation, timelineProtocol] = await Promise.all([
  readFile(new URL('../packages/web/src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/TaskCenterPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/TaskSurface.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/TaskHeader.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/TaskMessage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/TaskRound.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/TaskThinking.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/TaskToolGroup.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/TaskToolRow.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/task-detail-model.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/task-center.css', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/task-detail.css', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/ReviewPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/PiLivePage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/components/PiMarkdownComposer.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/PiLiveTaskRound.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/pi-live-task-projection.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/HubReviewPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/pi-live-history.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/protocol/src/pi-native.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/client/pi-live.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/pi-live.css', import.meta.url), 'utf8'),
  readFile(new URL('../packages/surface-http/src/pi-live.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/service.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/worker-host.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/worker-entry.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/in-process-host.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/sdk-loader.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/pi-sdk-adapter.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/package.json', import.meta.url), 'utf8'),
  readFile(new URL('../packages/core/src/domain/observation.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/protocol/src/timeline.ts', import.meta.url), 'utf8'),
])
const workspaceSidebar = await readFile(new URL('../packages/web/src/components/WorkspaceSidebar.tsx', import.meta.url), 'utf8')
const resumeResolver = await readFile(new URL('../packages/surface-http/src/pi-live-resume.ts', import.meta.url), 'utf8')
const piLiveProtocol = await readFile(new URL('../packages/protocol/src/pi-live.ts', import.meta.url), 'utf8')

const failures = []
const requireText = (source, pattern, label) => { if (!pattern.test(source)) failures.push(label) }

const primaryNavigationBlock = workspaceSidebar.match(/<nav className="workspace-primary-nav"[\s\S]*?<\/nav>/)?.[0] ?? ''
const topLevelLinks = [...primaryNavigationBlock.matchAll(/<NavLink\b/g)].length
if (topLevelLinks !== 3) failures.push(`一级导航必须保持任务中心 / 洞察 / 智能体 3 个，当前 ${topLevelLinks}`)
requireText(primaryNavigationBlock, /to="\/review"[\s\S]*?>[\s\S]*?任务中心/, '一级任务入口必须命名为“任务中心”')
requireText(primaryNavigationBlock, /to="\/insights"[\s\S]*?>[\s\S]*?洞察/, '一级分析入口必须命名为“洞察”')
requireText(primaryNavigationBlock, /to="\/agents"[\s\S]*?>[\s\S]*?智能体/, '一级 Agent 入口必须命名为“智能体”')
if (/to="\/(?:tools|backup|review\/live)"/.test(primaryNavigationBlock)) failures.push('工具分析、资产备份、Pi Live 不得占用一级导航')
requireText(workspaceSidebar, /to="\/tools"[\s\S]*?>工具分析/, '工具分析必须作为洞察上下文入口保留')
requireText(app, /path="\/review\/new"/, '缺少新建任务路由')
requireText(app, /path="\/review\/live"[^>]*element=\{<Navigate\s+to="\/review\/new"\s+replace\s*\/?>\}/, '旧 /review/live 必须重定向到新建任务')
requireText(app, /path="\/review\/live\/:runtimeSessionId"/, '缺少 Pi Live runtime 路由')
requireText(app, /onPiLive[\s\S]*!onPiLive/, 'Pi Live 必须从普通 Review overlay/turn rail 语义分离')
if (/to="\/review\/live"[^>]*>Pi 实时<\/NavLink>/.test(workspaceSidebar)) failures.push('一级导航不得保留独立 Pi 实时入口')

requireText(taskCenter, /<UiIcon name="plus"[^>]*\/>\s*新建任务/, '任务中心左侧必须通过统一图标提供新建任务入口')
requireText(taskCenter, /进行中 \+ 历史/, '任务中心必须统一进行中与历史任务')
requireText(taskCenter, /piLiveApi\.knownRuntimes\(\)/, '任务中心必须发现 Runtime 持有的 Pi Runtime')
requireText(taskCenter, /<TaskSurface\s+mode=\{surfaceMode\}>/, '历史、实时与 Hub 详情必须统一经过 TaskSurface')
requireText(taskCenter, /<ReviewPage[\s\S]{0,420}model=\{model\}[\s\S]{0,420}embedded/, 'Review 详情必须嵌入 TaskSurface')
requireText(taskCenter, /<PiLivePage\s+embedded\s*\/>/, 'Pi Live 必须嵌入 TaskSurface')
requireText(taskCenter, /<HubReviewPage\s+embedded\s*\/>/, 'Hub 详情必须嵌入 TaskSurface')
requireText(taskSurface, /data-task-surface-mode=\{mode\}/, 'TaskSurface 必须暴露稳定状态边界')
requireText(reviewPage, /ReviewPage\(\{[\s\S]{0,180}embedded = false/, 'ReviewPage 必须支持 embedded')
requireText(page, /PiLivePage\(\{ embedded = false \}/, 'PiLivePage 必须支持 embedded')
requireText(hubPage, /HubReviewPage\(\{ embedded = false \}/, 'HubReviewPage 必须支持 embedded')
requireText(taskCenter, /className="task-center-toolbar"/, '历史筛选栏必须由 TaskCenterPage 持有')
requireText(taskCenter, /筛选历史任务/, '统一筛选栏必须明确筛选历史任务')
requireText(reviewPage, /!embedded && <Toolbar className="workspace-toolbar"/, '嵌入 Review 不得生成重复筛选栏')
requireText(taskCenterCss, /\.task-center-toolbar\s*\{[\s\S]{0,260}grid-column:\s*1\s*\/\s*-1/, '任务中心筛选栏必须横跨列表和详情')
requireText(taskCenter, /deriveTaskProjectOptions/, '新建任务必须从已观测项目推导 cwd')
requireText(taskCenter, /cwd:\s*selected\.cwd/, 'Pi Runtime cwd 必须来自真实项目上下文')
if (/setCwd|工作目录\s*<input|placeholder=.*workspace/.test(taskCenter)) failures.push('主流程不得要求手输 cwd')
if (/\.task-center-main \.pi-live-page > \.pi-live-sessions\s*\{\s*display:\s*none;/m.test(taskCenterCss)) failures.push('不得靠 CSS 隐藏 Pi Live 第二套侧栏')
if (/\.task-center-main \.review-layout > \.session-panel\s*\{\s*display:\s*none;/m.test(taskCenterCss)) failures.push('不得靠 CSS 隐藏 Review 第二套侧栏')

requireText(taskHeader, /export function TaskHeader/, '统一 TaskHeader 缺失')
requireText(taskHeader, /task-header-metrics/, 'TaskHeader 缺少指标区域')
requireText(taskHeader, /task-header-actions/, 'TaskHeader 缺少操作区域')
requireText(reviewPage, /import \{ TaskHeader \} from '\.\/TaskHeader'/, 'Review 必须接入 TaskHeader')
requireText(page, /import \{ TaskHeader \} from '\.\/TaskHeader'/, 'Pi Live 必须接入 TaskHeader')
requireText(page, /<TaskHeader[\s\S]{0,1800}停止当前任务/, 'Pi Live 标题和控制必须由 TaskHeader 渲染')
if (/review-session-head/.test(reviewPage)) failures.push('Review 不得恢复旧详情头')
if (/pi-live-taskbar/.test(page)) failures.push('Pi Live 不得恢复旧 taskbar')

requireText(taskDetailModel, /export interface TaskDetailModel/, 'TaskDetailModel 缺失')
requireText(taskDetailModel, /contextLabel\?: string/, 'TaskDetailModel 缺少来源无关上下文')
requireText(taskDetailModel, /export interface TaskRoundModel/, 'TaskRoundModel 缺失')
if (/from ['"]@agent-lens\/protocol['"]|Review(?:Session|Interaction|Node)|PiLive/.test(taskDetailModel)) failures.push('TaskDetailModel 不得依赖 Review / Pi DTO')
requireText(taskRound, /export function TaskRound/, 'TaskRound 缺失')
requireText(taskRound, /defaultExpanded = true/, 'TaskRound 必须默认展开')
requireText(taskRound, /data-task-round-state=\{model\.state\}/, 'TaskRound 必须暴露状态边界')
requireText(reviewPage, /function ReviewRoundAdapter[\s\S]{0,2200}<TaskRound/, 'Review 轮次必须投影到 TaskRound')
requireText(reviewPage, /useMemo<TaskDetailModel \| null>/, 'Review 必须投影 TaskDetailModel')
requireText(reviewPage, /const \[expandAllRounds, setExpandAllRounds\] = useState\(true\)/, '历史轮次必须默认展开')

requireText(taskDetailModel, /export interface TaskThinkingModel/, 'TaskThinkingModel 缺失')
requireText(taskDetailModel, /export interface TaskToolGroupModel/, 'TaskToolGroupModel 缺失')
requireText(taskDetailModel, /export interface TaskToolModel/, 'TaskToolModel 缺失')
requireText(taskThinking, /export function TaskThinking/, 'TaskThinking 缺失')
requireText(taskThinking, /task-thinking/, 'TaskThinking 必须使用共享 Task Surface 语义类')
requireText(taskToolGroup, /export function TaskToolGroup/, 'TaskToolGroup 缺失')
requireText(taskToolGroup, /<TaskToolRow/, 'TaskToolGroup 必须统一通过 TaskToolRow')
requireText(taskToolRow, /export function TaskToolRow/, 'TaskToolRow 缺失')
requireText(taskToolRow, /<ToolKindIcon kind=\{(?:model\.kind|visualKind)\}/, 'TaskToolRow 必须使用语义 ToolKindIcon')
requireText(reviewPage, /return <TaskThinking[\s\S]{0,900}<MarkdownSurface/, 'Review Reasoning 必须由 TaskThinking 承载')
requireText(reviewPage, /function ReviewToolGroupAdapter[\s\S]{0,1800}<TaskToolGroup/, 'Review Tool 必须投影到 TaskToolGroup')

requireText(taskMessage, /export function TaskMessage/, 'TaskMessage 缺失')
requireText(taskMessage, /\{!user && <button/, '源码切换必须只属于 Agent Markdown')
requireText(taskMessage, /<span>源码<\/span>/, 'TaskMessage 必须保留源码操作')
requireText(taskMessage, /<span>渲染<\/span>/, 'TaskMessage 必须保留渲染操作')
requireText(taskMessage, /Streaming Tail 不使用本组件/, 'TaskMessage 必须明确排除 Streaming Tail')
requireText(reviewPage, /function MessageBubble[\s\S]{0,1200}<TaskMessage/, 'Review 消息必须通过 TaskMessage')
requireText(page, /import \{ PiLiveHistoryTaskRound, PiLiveRunningTaskRound \} from '\.\/PiLiveTaskRound'/, 'Pi Live 必须通过薄 Adapter 进入共享 Round')
requireText(page, /projectPiLiveTaskRounds\(history\)/, 'Pi Live 历史必须先投影为 TaskRoundModel')
requireText(page, /projectPiLiveTaskDetail\(\{[\s\S]{0,360}historyRounds,[\s\S]{0,220}runningRound/, 'Pi Live Runtime 必须收敛为 TaskDetailModel')
requireText(page, /agent=\{taskDetailModel\.agentLabel\}/, 'Pi Live Header Agent 必须来自 TaskDetailModel')
requireText(page, /context=\{taskDetailModel\.contextLabel\}/, 'Pi Live Header 上下文必须来自 TaskDetailModel')
requireText(page, /title=\{taskDetailModel\.title\}/, 'Pi Live Header 标题必须来自 TaskDetailModel')
requireText(page, /metrics=\{taskDetailModel\.metrics\}/, 'Pi Live Header 指标必须来自 TaskDetailModel')
requireText(page, /runningRound && <PiLiveRunningTaskRound[\s\S]{0,320}model=\{runningRound\}/, 'Running UI 与 TaskDetailModel 必须共用 TaskRoundModel')
requireText(piTaskProjection, /export function projectPiLiveRunningRound/, '缺少 Running -> TaskRoundModel 投影')
requireText(piTaskProjection, /export function projectPiLiveTaskDetail/, '缺少 Runtime -> TaskDetailModel 投影')
requireText(piTaskProjection, /contextLabel: runtimeModelLabel\(state\)/, 'TaskDetailModel 必须投影 Runtime 模型上下文')
requireText(page, /visibleHistoryRounds\.map[\s\S]{0,720}<PiLiveHistoryTaskRound/, '可见历史轮次必须通过 PiLiveHistoryTaskRound')
requireText(page, /<PiLiveRunningTaskRound[\s\S]{0,520}thinkingText=\{thinkingText\}[\s\S]{0,520}streamText=\{streamText\}/, '当前轮次必须通过共享 Running Adapter')
requireText(piTaskRound, /import \{ TaskMessage \} from '\.\/TaskMessage'/, 'Pi 历史消息必须接入 TaskMessage')
requireText(piTaskRound, /function HistoryThinking[\s\S]{0,900}<TaskThinking/, 'Pi 历史 Thinking 必须通过 TaskThinking')
requireText(piTaskRound, /function HistoryToolGroup[\s\S]{0,1400}<TaskToolGroup/, 'Pi 历史 Tool 必须进入 TaskToolGroup')
requireText(piTaskRound, /export function PiLiveRunningTaskRound[\s\S]{0,3200}<TaskRound/, 'Pi Running 必须复用 TaskRound')
requireText(piTaskRound, /\(waiting \|\| streamText\) && <div className=\{`pi-live-stream-response/, 'Streaming Tail 必须保持独立实时渲染并复用等待态外壳')
requireText(piTaskProjection, /export const PI_LIVE_HISTORY_ROUND_FACT_LIMIT = 8/, '历史 Round 必须保持 8 Fact 分片上限')
requireText(piTaskProjection, /export function projectPiLiveTaskRounds/, '缺少 History -> TaskRoundModel 投影')
if (/⌁/.test(`${page}\n${piTaskRound}`)) failures.push('Tool 不得恢复通用占位图标')

requireText(piComposer, /KEY_ENTER_COMMAND/, 'Lexical 输入框缺少 Enter 命令边界')
requireText(piComposer, /event\.isComposing/, 'Lexical 输入框缺少 isComposing 保护')
requireText(piComposer, /keyCode === 229/, 'Lexical 输入框缺少 IME 229 兼容')
requireText(page, /piLiveApi\.abort\(runtimeId, true\)/, '停止任务必须取回队列再 Abort')
requireText(page, /piLiveApi\.terminate\(runtimeId\)/, '结束 Runtime 必须是独立显式操作')
requireText(page, /followingRef/, '缺少用户滚动跟随状态')
requireText(page, /setNewRecords\(true\)/, '阅读历史时缺少新记录提示')
requireText(page, /extensionResponse/, '缺少 Extension UI 回应链')
requireText(page, /PiLiveTransportDiagnostics/, '缺少传输性能诊断')
requireText(page, /type === 'model_changed' \|\| type === 'thinking_level_changed'/, 'Runtime Event 必须使用实时协议命名')
if (/type === 'model_change' \|\| type === 'thinking_level_change'/.test(page)) failures.push('不得把持久化 Entry 名称当 Runtime Event')
requireText(page, /projectPiLiveHistory\(snapshot\)/, '页面必须使用持久化历史事实投影')

requireText(history, /normalizePiSessionEntry/, '历史投影必须复用 Pi Native Normalizer')
requireText(piNative, /type === 'model_change'/, 'Normalizer 缺少 model_change')
requireText(piNative, /type === 'thinking_level_change'/, 'Normalizer 缺少 thinking_level_change')
requireText(piNative, /role === 'tool' \|\| role === 'toolResult'/, 'Normalizer 缺少 Tool Result')
if (/function\s+(?:messageItems|lifecycleItem|toolResultFacts)\b/.test(history)) failures.push('Web 不得重复维护 Session Entry Parser')
requireText(coreObservation, /'thinking\.level\.changed'/, 'Core 缺少 thinking.level.changed')
requireText(timelineProtocol, /'thinking\.level\.changed'/, 'Timeline 缺少 thinking.level.changed')

requireText(client, /requestJson<PiLiveStateDto\[]>\('\/api\/v1\/pi-live'\)/, '活跃任务必须优先从 Runtime 服务端列举')
requireText(client, /Compatibility fallback[\s\S]*readKnownRuntimeIds\(\)/, '活跃任务需保留旧 Runtime 兼容回退')
requireText(client, /HIDDEN_FLUSH_MS = 250/, '后台页面必须降低 Streaming UI 提交频率')
requireText(client, /requestAnimationFrame/, '前台 Streaming 必须按动画帧批量提交')
requireText(client, /coalescedEvents/, 'Scheduler 缺少事件合并诊断')
requireText(client, /tool_execution_update[\s\S]*latest value replaces earlier progress/, 'Tool Progress 必须替换合并累计结果')
requireText(client, /source\.close\(\)/, '关闭 View 必须只关闭 EventSource')
if (/terminate\([^)]*\)[\s\S]{0,120}source\.close/.test(client)) failures.push('View dispose 不得隐式 terminate Runtime')

requireText(piLiveProtocol, /interface PiLiveResumeRequestDto[\s\S]{0,100}logicalSessionId:\s*string/, '协议缺少 Pi 历史会话恢复请求')
requireText(taskCenter, /piLiveApi\.resume\(logicalSessionId\)/, '任务中心必须通过受控 API 恢复 Pi 历史会话')
requireText(reviewPage, /detail\.sourceIds\.includes\('pi'\)[\s\S]{0,320}继续会话/, 'Pi 历史详情必须提供继续会话操作')
requireText(client, /'\/api\/v1\/pi-live\/resume'[\s\S]{0,180}logicalSessionId/, 'Web Client 缺少 Pi 历史会话恢复端点')

requireText(http, /url\.pathname === '\/api\/v1\/pi-live'[\s\S]*request\.method === 'GET'[\s\S]*service\.list\(\)/, 'HTTP Surface 必须支持列举活跃 Runtime')
requireText(http, /url\.pathname === '\/api\/v1\/pi-live\/resume'[\s\S]{0,520}resolvePiLiveResumeInput[\s\S]{0,180}service\.start\(input\)/, 'HTTP Surface 必须从历史会话安全恢复 Pi Runtime')
requireText(resumeResolver, /item\.sourceId === 'pi'[\s\S]{0,420}isAbsolute\(item\.locator\.path\)[\s\S]{0,220}\.jsonl/, '恢复解析器必须只接受 Pi 的绝对 JSONL 证据')
requireText(resumeResolver, /sourceRecords\.getMany[\s\S]{0,180}getMany\(sourceRecordIds\)/, '恢复解析器必须批量读取原始记录，避免逐条数据库查询')
requireText(resumeResolver, /await stat\(sessionPath\)/, '恢复解析器必须验证原生文件存在')
requireText(resumeResolver, /await isMatchingPiSessionFile\(sessionPath, nativeSessionIds\)/, '恢复解析器必须验证原生 JSONL 身份')
requireText(resumeResolver, /workspace\?\.path\?\.trim\(\)\s*\|\|\s*sourceRecordCwd\(sourceRecord\)/, '恢复解析器必须恢复原工作目录')
requireText(http, /request\.once\('close', cleanup\)/, 'SSE 断开必须释放订阅')
requireText(http, /service\.terminate\(runtimeSessionId\)/, 'Runtime 只能显式 DELETE 终止')
requireText(runtime, /async list\(\): Promise<PiLiveRuntimeState\[]>/, 'Runtime Service 必须提供活跃任务列举')
requireText(runtime, /status: 'initializing'/, 'Runtime Start 必须先返回 initializing')
requireText(runtime, /runtime\.initialization\.abort\(\)/, 'initializing Terminate 必须取消 Worker 初始化')
requireText(runtime, /sessionPathKey[\s\S]{0,900}该 Pi 历史会话已经在进行中/, 'Runtime 必须阻止同一原生 Pi 会话被重复打开')
requireText(workerHost, /fork\(entry, \[\], forkOptions\)/, 'Pi SDK 必须由独立 Worker 承载')
requireText(workerHost, /MAX_PENDING_REQUESTS/, 'Worker IPC 待处理请求必须有界')
requireText(workerEntry, /const queue = value\.restoreQueue === false[\s\S]{0,180}session\.clearQueue\(\)/, 'Abort 必须支持队列取回')
requireText(workerEntry, /session\.bindExtensions\(/, 'Worker 必须通过官方 AgentSession 绑定 Extension Runtime')
requireText(workerEntry, /SessionManager\.open\(input\.sessionPath, input\.sessionDir, input\.cwd\)/, 'Worker 必须通过官方 SessionManager.open 恢复历史会话')
requireText(inProcessHost, /assertPiSdkSession\(created\.session, installed\.sdkEntry, installed\.version\)/, 'SDK 契约夹具必须校验 AgentSession capability')
requireText(workerEntry, /extensionUi\.respond\(value\.requestId, value\.response\)/, 'Extension UI 必须关联 Worker request id')

requireText(sdkAdapter, /from '@earendil-works\/pi-coding-agent'/, 'SDK Adapter 必须从官方包派生类型')
requireText(sdkAdapter, /PI_SDK_TYPE_BASELINE = '0\.84\.4'/, 'SDK Adapter 必须记录 0.84.4 类型基线')
requireText(sdkAdapter, /type PiSdkModel = Pick<OfficialPiModel/, 'SDK Adapter 只暴露所需官方类型能力')
requireText(sdkAdapter, /export function assertPiSdkModule/, '缺少 Module capability 校验')
requireText(sdkAdapter, /export function assertPiSdkSession/, '缺少 Session capability 校验')
requireText(sdkAdapter, /export function asPiSdkExtensionUiContext/, '缺少 Extension UI capability 校验')
requireText(runtimePackage, /"@earendil-works\/pi-coding-agent":\s*"0\.84\.4"/, 'runtime-cordis 必须以官方 Pi SDK 0.84.4 为类型基线')
requireText(sdkLoader, /PI_SDK_PACKAGE_NAME/, 'Loader 必须只定位官方 Pi npm 包')
requireText(workerEntry, /await import\(pathToFileURL\(discovery\.sdkEntry\)\.href\)/, '必须在 Worker 内加载用户实际安装的官方 SDK')
requireText(sdkLoader, /assertPiSdkModule\(imported, discovery\.sdkEntry, discovery\.version\)/, 'Loader 必须执行 Module capability 校验')
if (/export interface PiSdk(?:Session|Module|Model)/.test(sdkLoader)) failures.push('Loader 不得维护手写 SDK 接口镜像')
if (/PiRpcClient|--mode['"\s,]+rpc|child_process/.test(`${runtime}\n${sdkLoader}`)) failures.push('Runtime 不得重新引入自维护 RPC 子进程协议')

const stableVisibleCss = `${taskCenterCss}\n${taskDetailCss}`
if (/font-size:\s*(?:[0-9]|1[01])px/.test(stableVisibleCss)) failures.push('任务中心 / Task Surface 正式可见文字不得小于 12px')
if (/backdrop-filter|filter:\s*blur\(/.test(`${css}\n${stableVisibleCss}`)) failures.push('Pi Live / 任务中心不得使用模糊/毛玻璃')
if (/max-width:\s*575|max-width:\s*576|min-width:\s*576/.test(`${css}\n${stableVisibleCss}`)) failures.push('Pi Live / 任务中心不得新增 576px 断点')
for (const expected of ['1199.98px', '991.98px', '767.98px']) {
  if (!css.includes(expected)) failures.push(`Pi Live CSS 缺少响应式基线 ${expected}`)
  if (!taskCenterCss.includes(expected)) failures.push(`任务中心 CSS 缺少响应式基线 ${expected}`)
  if (!taskDetailCss.includes(expected)) failures.push(`Task Surface CSS 缺少响应式基线 ${expected}`)
}
requireText(css, /\.pi-live-compose-hint,[\s\S]{0,260}position:\s*absolute/, 'Pi Composer 快捷提示必须绝对定位，不得撑高输入区')
requireText(taskDetailCss, /\.task-surface-live \.task-header\s*\{[\s\S]{0,220}grid-template-rows:\s*30px/, 'Pi Live 桌面 Header 必须保持单行，不让排队/PID独占一行')

if (failures.length) {
  console.error('Pi Live / 任务中心契约检查失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log('Pi Live / 任务中心契约检查通过：统一 TaskSurface、三大工作区导航、独立 SDK Worker、异步状态机、有界 IPC、队列/Abort、历史事实、IME、滚动跟随与响应式布局已锁定。')
