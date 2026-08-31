import { readFile } from 'node:fs/promises'

const [app, taskCenter, taskSurface, taskHeader, taskMessage, taskRound, taskThinking, taskToolGroup, taskToolRow, taskDetailModel, taskCenterCss, taskHeaderCss, reviewPage, page, piTaskRound, piTaskProjection, hubPage, history, client, css, http, runtime, sdkLoader, sdkAdapter, runtimePackage, coreObservation, timelineProtocol] = await Promise.all([
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
  readFile(new URL('../packages/web/src/features/task-header.css', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/ReviewPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/PiLivePage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/PiLiveTaskRound.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/pi-live-task-projection.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/HubReviewPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/pi-live-history.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/client/pi-live.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/pi-live.css', import.meta.url), 'utf8'),
  readFile(new URL('../packages/surface-http/src/pi-live.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/service.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/sdk-loader.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/pi-sdk-adapter.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/package.json', import.meta.url), 'utf8'),
  readFile(new URL('../packages/core/src/domain/observation.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/protocol/src/timeline.ts', import.meta.url), 'utf8'),
])

const failures = []
const requireText = (source, pattern, label) => {
  if (!pattern.test(source)) failures.push(label)
}

const navigationBlock = app.match(/const navigation = \[([\s\S]*?)\] as const/)?.[1] ?? ''
const topLevelLinks = [...navigationBlock.matchAll(/to:\s*'\/(review|tools|insights|agents|backup)'/g)].length
if (topLevelLinks !== 5) failures.push(`一级导航必须保持 5 个，当前检测到 ${topLevelLinks}`)
requireText(navigationBlock, /to:\s*'\/review',\s*label:\s*'任务中心'/, 'Pi Live 并入实时任务后，一级任务入口必须命名为“任务中心”')
requireText(app, /path="\/review\/new"/, '任务中心缺少新建任务路由')
requireText(app, /path="\/review\/live"[^>]*element=\{<Navigate\s+to="\/review\/new"\s+replace\s*\/?>\}/, '旧 /review/live 入口必须重定向到任务中心新建任务')
requireText(app, /path="\/review\/live\/:runtimeSessionId"/, '缺少 Pi Live runtime 路由')
requireText(app, /onPiLive[\s\S]*!onPiLive/, 'Pi Live 必须从普通 Review overlay/turn rail 语义中分离')
if (/to="\/review\/live"[^>]*>Pi 实时<\/NavLink>/.test(app)) failures.push('顶部 Header 不得继续保留独立“Pi 实时”产品入口')

requireText(taskCenter, /\+ 新建任务/, '任务中心左侧必须提供统一“新建任务”入口')
requireText(taskCenter, /进行中 \+ 历史/, '任务中心必须明确统一进行中与历史任务')
requireText(taskCenter, /piLiveApi\.knownRuntimes\(\)/, '任务中心必须发现当前 AgentLens Runtime 持有的 Pi Runtime')
requireText(taskCenter, /<TaskSurface\s+mode=\{surfaceMode\}>/, '任务中心历史、实时与 Hub 详情必须统一经过 TaskSurface 宿主')
requireText(taskCenter, /<ReviewPage\s+model=\{model\}\s+embedded\s*\/>/, '任务中心历史详情必须以嵌入态进入 TaskSurface')
requireText(taskCenter, /<PiLivePage\s+embedded\s*\/>/, '任务中心 Pi Live 必须以嵌入态进入 TaskSurface')
requireText(taskCenter, /<HubReviewPage\s+embedded\s*\/>/, '任务中心 Hub 详情必须以嵌入态进入 TaskSurface')
requireText(taskSurface, /data-task-surface-mode=\{mode\}/, 'TaskSurface 必须暴露稳定的详情状态边界')
requireText(reviewPage, /ReviewPage\(\{ model, embedded = false \}/, 'ReviewPage 必须支持不生成自身会话侧栏的嵌入态')
requireText(page, /PiLivePage\(\{ embedded = false \}/, 'PiLivePage 必须支持不生成自身实时任务侧栏的嵌入态')
requireText(hubPage, /HubReviewPage\(\{ embedded = false \}/, 'HubReviewPage 必须支持不生成自身会话侧栏\/工具栏的嵌入态')
requireText(taskCenter, /className="task-center-toolbar"/, '历史任务筛选栏必须由 TaskCenterPage 统一持有')
requireText(taskCenter, /筛选历史任务/, '任务中心统一筛选栏必须明确筛选历史任务')
requireText(reviewPage, /!embedded && <div className="workspace-toolbar">/, '嵌入态 Review 不得继续生成重复筛选栏')
requireText(taskCenterCss, /\.task-center-toolbar\s*\{[\s\S]{0,260}grid-column:\s*1\s*\/\s*-1/, '任务中心统一筛选栏必须横跨任务列表与详情区域')
requireText(taskCenter, /deriveTaskProjectOptions/, '新建任务必须从已观测项目上下文推导工作目录')
requireText(taskCenter, /cwd:\s*selected\.cwd/, 'Pi Runtime cwd 必须来自已选择的真实项目上下文')
if (/setCwd|工作目录\s*<input|placeholder=.*workspace/.test(taskCenter)) failures.push('任务中心新建主流程不得要求用户手输 cwd')
if (/\.task-center-main \.pi-live-page > \.pi-live-sessions\s*\{\s*display:\s*none;/m.test(taskCenterCss)) failures.push('任务中心不得继续依赖 CSS 隐藏 Pi Live 第二套侧栏')
if (/\.task-center-main \.review-layout > \.session-panel\s*\{\s*display:\s*none;/m.test(taskCenterCss)) failures.push('任务中心不得继续依赖 CSS 隐藏 Review 第二套侧栏')
if (/\.task-center-main \.hub-review-toolbar\s*\{\s*display:\s*none;/m.test(taskCenterCss)) failures.push('任务中心不得继续依赖 CSS 隐藏 Hub 工具栏')

requireText(taskHeader, /export function TaskHeader/, '统一 Task Header 组件缺失')
requireText(taskHeader, /task-header-metrics/, '统一 Task Header 必须提供共享指标区域')
requireText(taskHeader, /task-header-actions/, '统一 Task Header 必须提供共享操作区域')
requireText(reviewPage, /import \{ TaskHeader \} from '\.\/TaskHeader'/, 'Review 必须接入统一 TaskHeader')
requireText(reviewPage, /<TaskHeader[\s\S]{0,1800}metrics=\{taskDetailModel\?\.metrics/, 'Review 详情头必须通过 TaskDetailModel 向 TaskHeader 投影指标')
requireText(page, /import \{ TaskHeader \} from '\.\/TaskHeader'/, 'Pi Live 必须接入统一 TaskHeader')
requireText(page, /<TaskHeader[\s\S]{0,1800}停止当前任务/, 'Pi Live 运行态标题和控制必须通过 TaskHeader 渲染')
if (/review-session-head/.test(reviewPage)) failures.push('Review 不得继续保留旧 review-session-head 详情头结构')
if (/pi-live-taskbar/.test(page)) failures.push('Pi Live 不得继续保留旧 pi-live-taskbar 详情头结构')

requireText(taskDetailModel, /export interface TaskDetailModel/
requireText(taskDetailModel, /contextLabel\?: string/, 'TaskDetailModel 必须提供来源无关的二级上下文字段'), '统一 TaskDetailModel 缺失')
requireText(taskDetailModel, /export interface TaskRoundModel/, '统一 TaskRoundModel 缺失')
if (/from ['"]@agent-lens\/protocol['"]|Review(?:Session|Interaction|Node)|PiLive/.test(taskDetailModel)) failures.push('TaskDetailModel 必须保持来源无关，不得依赖 Review / Pi DTO')
requireText(taskRound, /export function TaskRound/, '统一 TaskRound 组件缺失')
requireText(taskRound, /defaultExpanded = true/, 'TaskRound 必须默认展开')
requireText(taskRound, /data-task-round-state=\{model\.state\}/, 'TaskRound 必须暴露 settled / running / stopped 状态边界')
requireText(reviewPage, /import \{ TaskRound \} from '\.\/TaskRound'/, 'Review 必须接入统一 TaskRound')
requireText(reviewPage, /function ReviewRoundAdapter[\s\S]{0,2200}<TaskRound/, 'Review 轮次必须通过 Review Adapter 投影到 TaskRound')
requireText(reviewPage, /useMemo<TaskDetailModel \| null>/, 'Review 必须投影统一 TaskDetailModel')
requireText(reviewPage, /const \[expandAllRounds, setExpandAllRounds\] = useState\(true\)/, '历史轮次必须默认展开')
if (/function Interaction\(/.test(reviewPage)) failures.push('Review 不得继续保留旧 Interaction 轮次外壳；应由 TaskRound 承载')

requireText(taskDetailModel, /export interface TaskThinkingModel/, '统一 TaskThinkingModel 缺失')
requireText(taskDetailModel, /export interface TaskToolGroupModel/, '统一 TaskToolGroupModel 缺失')
requireText(taskDetailModel, /export interface TaskToolModel/, '统一 TaskToolModel 缺失')
requireText(taskThinking, /export function TaskThinking/, '统一 TaskThinking 组件缺失')
requireText(taskThinking, /thinking-block/, 'TaskThinking 必须保持执行轨 Thinking 视觉语义')
requireText(taskToolGroup, /export function TaskToolGroup/, '统一 TaskToolGroup 组件缺失')
requireText(taskToolGroup, /<TaskToolRow/, 'TaskToolGroup 必须统一通过 TaskToolRow 渲染单工具')
requireText(taskToolRow, /export function TaskToolRow/, '统一 TaskToolRow 组件缺失')
requireText(taskToolRow, /<ToolKindIcon kind=\{model\.kind\}/, 'TaskToolRow 必须使用语义 ToolKindIcon，不得退回通用占位图标')
requireText(reviewPage, /import \{ TaskThinking \} from '\.\/TaskThinking'/, 'Review Reasoning 必须接入 TaskThinking')
requireText(reviewPage, /return <TaskThinking[\s\S]{0,900}<MarkdownSurface/, 'Review Reasoning 必须由 TaskThinking 承载并保留 Markdown')
requireText(reviewPage, /import \{ TaskToolGroup \} from '\.\/TaskToolGroup'/, 'Review Tool Group 必须接入 TaskToolGroup')
requireText(reviewPage, /function ReviewToolGroupAdapter[\s\S]{0,1800}<TaskToolGroup/, 'Review Tool 必须经 Adapter 投影到 TaskToolGroup')
if (/function ToolRow\(/.test(reviewPage) || /function ToolRunGroup\(/.test(reviewPage)) failures.push('Review 不得继续维护旧 ToolRow / ToolRunGroup 组件副本')

requireText(taskMessage, /export function TaskMessage/, '统一 Task Message 组件缺失')
requireText(taskMessage, />查看源码</, '统一 Task Message 必须保留“查看源码”')
requireText(taskMessage, /返回渲染/, '统一 Task Message 必须保留“返回渲染”')
requireText(taskMessage, /Streaming Tail 不使用本组件/, '统一 Task Message 必须明确排除 Streaming Tail')
requireText(reviewPage, /import \{ TaskMessage \} from '\.\/TaskMessage'/, 'Review 已完成消息必须接入统一 TaskMessage')
requireText(reviewPage, /function MessageBubble[\s\S]{0,1200}<TaskMessage/, 'Review 用户/AI 消息必须通过 TaskMessage 渲染')
requireText(page, /import \{ PiLiveHistoryTaskRound, PiLiveRunningTaskRound \} from '\.\/PiLiveTaskRound'/, 'Pi Live 页面必须通过薄 Adapter 进入共享 Task Round')
requireText(page, /projectPiLiveTaskRounds\(history\)/, 'Pi Live 历史事实必须先投影为共享 TaskRoundModel')
requireText(page, /projectPiLiveTaskDetail\(\{[\s\S]{0,360}historyRounds,[\s\S]{0,220}runningRound/, 'Pi Live 必须把 Runtime 状态与 Round 收敛为统一 TaskDetailModel')
requireText(page, /agent=\{taskDetailModel\.agentLabel\}/, 'Pi Live TaskHeader 的 Agent 必须来自 TaskDetailModel')
requireText(page, /context=\{taskDetailModel\.contextLabel\}/, 'Pi Live TaskHeader 上下文必须来自 TaskDetailModel')
requireText(page, /title=\{taskDetailModel\.title\}/, 'Pi Live TaskHeader 标题必须来自 TaskDetailModel')
requireText(page, /metrics=\{taskDetailModel\.metrics\}/, 'Pi Live TaskHeader 指标必须来自 TaskDetailModel')
requireText(page, /runningRound && <PiLiveRunningTaskRound[\s\S]{0,320}model=\{runningRound\}/, 'Pi Live Running UI 与 TaskDetailModel 必须复用同一 TaskRoundModel')
requireText(piTaskProjection, /export function projectPiLiveRunningRound/, 'Pi Live 缺少 Running -> TaskRoundModel 投影')
requireText(piTaskProjection, /export function projectPiLiveTaskDetail/, 'Pi Live 缺少 Runtime -> TaskDetailModel 投影')
requireText(piTaskProjection, /contextLabel: runtimeModelLabel\(state\)/, 'Pi Live TaskDetailModel 必须投影 Runtime 模型上下文')
requireText(page, /historyRounds\.map[\s\S]{0,720}<PiLiveHistoryTaskRound/, 'Pi Live 历史轮次必须通过 PiLiveHistoryTaskRound 渲染')
requireText(page, /<PiLiveRunningTaskRound[\s\S]{0,520}thinkingText=\{thinkingText\}[\s\S]{0,520}streamText=\{streamText\}/, 'Pi Live 当前轮次必须通过共享 Running TaskRound Adapter 渲染')
requireText(piTaskRound, /import \{ TaskMessage \} from '\.\/TaskMessage'/, 'Pi Live 已完成消息必须在 TaskRound Adapter 中接入统一 TaskMessage')
requireText(piTaskRound, /export function PiLiveHistoryTaskRound[\s\S]{0,2600}<TaskMessage/, 'Pi Live 持久化消息必须通过 TaskMessage 渲染')
requireText(piTaskRound, /export function PiLiveHistoryTaskRound[\s\S]{0,2600}<TaskThinking/, 'Pi Live 历史 Thinking 必须通过 TaskThinking 渲染')
requireText(piTaskRound, /export function PiLiveHistoryTaskRound[\s\S]{0,3200}<TaskToolGroup/, 'Pi Live 历史 Tool 必须通过 TaskToolGroup 渲染')
requireText(piTaskRound, /export function PiLiveRunningTaskRound[\s\S]{0,3200}<TaskRound/, 'Pi Live Running 状态必须复用 TaskRound')
requireText(piTaskRound, /streamText && <div className="pi-live-stream-response"/, 'Pi Live Streaming Tail 必须保留独立实时渲染，不得误接源码切换')
requireText(piTaskProjection, /export const PI_LIVE_HISTORY_ROUND_FACT_LIMIT = 8/, 'Pi Live 超长语义 Round 必须保留 8 Fact 显示分片上限')
requireText(piTaskProjection, /export function projectPiLiveTaskRounds/, 'Pi Live 缺少 History -> TaskRoundModel 投影')
if (/⌁/.test(`${page}\n${piTaskRound}`)) failures.push('Pi Live Tool 不得恢复通用 ⌁ 占位图标，应统一使用 ToolKindIcon')

requireText(page, /onCompositionStart/, 'Pi Live 输入框缺少 compositionstart 保护')
requireText(page, /nativeEvent\.isComposing/, 'Pi Live 输入框缺少 isComposing 保护')
requireText(page, /keyCode === 229/, 'Pi Live 输入框缺少 IME keyCode 229 兼容')
requireText(page, /piLiveApi\.abort\(runtimeId, true\)/, '停止任务必须先取回 Pi 队列再 Abort')
requireText(page, /piLiveApi\.terminate\(runtimeId\)/, '结束 Runtime 必须是独立显式操作')
requireText(page, /followingRef/, 'Pi Live 缺少用户滚动跟随状态')
requireText(page, /setNewRecords\(true\)/, '历史阅读时缺少“有新记录”提示')
requireText(page, /extensionResponse/, 'Pi Live 缺少 Extension UI 回应链')
requireText(page, /PiLiveTransportDiagnostics/, 'Pi Live 页面缺少传输性能诊断')
requireText(page, /type === 'model_changed' \|\| type === 'thinking_level_changed'/, 'Pi Live Runtime Event 必须使用 Pi 实时协议命名')
if (/type === 'model_change' \|\| type === 'thinking_level_change'/.test(page)) failures.push('Pi Live 不得把持久化 Entry 名称误当 Runtime Event 名称')
requireText(page, /projectPiLiveHistory\(snapshot\)/, 'Pi Live 页面必须使用持久化历史事实投影')

requireText(history, /type === 'model_change'/, 'Pi Live 历史投影缺少持久化 model_change')
requireText(history, /type === 'thinking_level_change'/, 'Pi Live 历史投影缺少持久化 thinking_level_change')
requireText(history, /message\.role !== 'tool' && message\.role !== 'toolResult'/, 'Pi Live 历史投影缺少 Tool Result 事实')
requireText(coreObservation, /'thinking\.level\.changed'/, 'Core ObservationKind 缺少 thinking.level.changed')
requireText(timelineProtocol, /'thinking\.level\.changed'/, 'Timeline Protocol 缺少 thinking.level.changed')

requireText(client, /requestJson<PiLiveStateDto\[]>\('\/api\/v1\/pi-live'\)/, 'Pi 活跃任务必须优先从 Runtime 服务端列举，不能只依赖浏览器 localStorage')
requireText(client, /Compatibility fallback[\s\S]*readKnownRuntimeIds\(\)/, 'Pi 活跃任务需要保留新 Web 对旧 Runtime 的兼容回退')
requireText(client, /HIDDEN_FLUSH_MS = 250/, '后台页面必须降低 Streaming UI 提交频率')
requireText(client, /requestAnimationFrame/, '前台 Streaming 必须按动画帧批量提交')
requireText(client, /coalescedEvents/, 'Streaming Scheduler 缺少事件合并诊断')
requireText(client, /tool_execution_update[\s\S]*latest value replaces earlier progress/, 'Tool Progress 必须使用 Pi 累计结果进行替换合并')
requireText(client, /source\.close\(\)/, '关闭 Pi Live View 必须只关闭 EventSource')
if (/terminate\([^)]*\)[\s\S]{0,120}source\.close/.test(client)) failures.push('View dispose 不得隐式 terminate Pi Runtime')

requireText(http, /url\.pathname === '\/api\/v1\/pi-live'[\s\S]*request\.method === 'GET'[\s\S]*service\.list\(\)/, 'Pi Live HTTP Surface 必须允许 GET 根路径列举 Runtime 持有的活跃任务')
requireText(http, /request\.once\('close', cleanup\)/, 'Pi Live SSE 断开必须释放订阅')
requireText(http, /service\.terminate\(runtimeSessionId\)/, 'Pi Runtime 必须只有显式 DELETE 终止路径')
requireText(runtime, /async list\(\): Promise<PiLiveRuntimeState\[]>/, 'Pi Runtime Service 必须提供当前 generation 活跃 Runtime 列举')
requireText(runtime, /async clearQueue\(runtimeSessionId: string\)[\s\S]{0,180}\.session\.clearQueue\(\)/, 'Abort 必须支持队列取回')
requireText(runtime, /session\.bindExtensions\(/, 'Pi Live 必须通过官方 AgentSession 绑定 Extension Runtime')
requireText(runtime, /assertPiSdkSession\(created\.session, installed\.sdkEntry, installed\.version\)/, 'Pi Live 启动前必须校验实际 AgentSession capability')
requireText(runtime, /extensionUi\.respond\(requestId, response\)/, 'Extension UI 必须原样关联 Pi SDK request id')

requireText(sdkAdapter, /from '@earendil-works\/pi-coding-agent'/, 'Pi SDK Adapter 必须直接从官方包派生开发期类型')
requireText(sdkAdapter, /PI_SDK_TYPE_BASELINE = '0\.84\.4'/, 'Pi SDK Adapter 必须记录当前官方类型基线 0.84.4')
requireText(sdkAdapter, /type PiSdkModel = Pick<OfficialPiModel/, 'Pi SDK Adapter 应只暴露 AgentLens 实际需要的官方类型能力，不得泄漏整个 Pi 内部类')
requireText(sdkAdapter, /export function assertPiSdkModule/, 'Pi SDK Adapter 缺少 Module capability 校验')
requireText(sdkAdapter, /export function assertPiSdkSession/, 'Pi SDK Adapter 缺少 Session capability 校验')
requireText(sdkAdapter, /export function asPiSdkExtensionUiContext/, 'Pi SDK Adapter 缺少 Extension UI capability 校验')
requireText(runtimePackage, /"@earendil-works\/pi-coding-agent":\s*"0\.84\.4"/, 'runtime-cordis 必须以官方 Pi SDK 0.84.4 作为开发/CI 类型基线')
requireText(sdkLoader, /PI_SDK_PACKAGE_NAME/, 'Pi Live Loader 必须只定位官方 Pi npm 包')
requireText(sdkLoader, /await import\(pathToFileURL\(discovery\.sdkEntry\)\.href\)/, 'Pi Live 必须进程内加载用户实际安装的官方 SDK，不得捆绑第二份 Runtime')
requireText(sdkLoader, /assertPiSdkModule\(imported, discovery\.sdkEntry, discovery\.version\)/, 'Pi Live Loader 必须执行官方 SDK Module capability 校验')
if (/export interface PiSdk(?:Session|Module|Model)/.test(sdkLoader)) failures.push('Pi SDK Loader 不得重新维护手写 SDK 接口镜像；类型边界必须收敛到 PiSdkAdapter')
if (/PiRpcClient|--mode['"\s,]+rpc|child_process/.test(`${runtime}\n${sdkLoader}`)) failures.push('Pi Live Runtime 不得重新引入自维护 RPC 子进程协议')

const visibleCss = `${css}\n${taskCenterCss}\n${taskHeaderCss}`
if (/font-size:\s*(?:[0-9]|1[01])px/.test(visibleCss)) failures.push('Pi Live / 任务中心可见文字不得小于 12px')
if (/backdrop-filter|filter:\s*blur\(/.test(visibleCss)) failures.push('Pi Live / 任务中心不得使用模糊/毛玻璃')
if (/max-width:\s*575|max-width:\s*576|min-width:\s*576/.test(visibleCss)) failures.push('Pi Live / 任务中心不得新增 576px 响应式断点')
for (const expected of ['1199.98px', '991.98px', '767.98px']) {
  if (!css.includes(expected)) failures.push(`Pi Live CSS 缺少现有响应式基线 ${expected}`)
  if (!taskCenterCss.includes(expected)) failures.push(`任务中心 CSS 缺少现有响应式基线 ${expected}`)
  if (!taskHeaderCss.includes(expected)) failures.push(`TaskHeader CSS 缺少现有响应式基线 ${expected}`)
}

if (failures.length) {
  console.error('Pi Live / 任务中心契约检查失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('Pi Live / 任务中心契约检查通过：统一 TaskSurface、TaskHeader、TaskMessage、TaskDetailModel、TaskRound、TaskThinking、TaskToolGroup、TaskToolRow、任务中心历史筛选栏、嵌入态详情、官方 Pi SDK 类型适配与 capability 校验、活跃任务列举、项目上下文启动、事件层级、历史事实、IME、Stop/Terminate、滚动跟随、Extension UI、背压与性能诊断已锁定。')
