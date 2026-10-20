import { readFile } from 'node:fs/promises'

const [
  app,
  taskCenter,
  taskLiveRuntime,
  legacyRedirect,
  liveNewTask,
  liveTask,
  liveTaskRuntimeHook,
  liveTaskHistoryHook,
  liveTaskActionsHook,
  liveTaskStateHook,
  liveTaskQueue,
  liveTaskInput,
  liveTaskTimeline,
  liveTaskHistoryWindow,
  liveTaskProjection,
  liveStyles,
  liveClient,
  liveProtocol,
  liveCore,
  architectureTest,
  reviewPage,
  reviewLiveInteraction,
  liveComposer,
  taskMessage,
  liveImageNode,
  liveAttachmentClient,
  liveAttachmentHttp,
  liveHttp,
  piLiveAdapter,
  zhTaskLocale,
  enTaskLocale,
] = await Promise.all([
  readFile(new URL('../packages/web/src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/TaskCenterPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/task-live-runtime.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/LegacyLiveTaskRedirect.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/LiveNewTaskPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/LiveTaskPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/use-live-task-runtime.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/use-live-task-history.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/use-live-task-actions.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/live-task-state.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/live-task-queue.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/live-task-input.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/LiveTaskTimeline.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/live-task-history-window.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/live-task-projection.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/live-task.css', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/client/live.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/protocol/src/live.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/core/src/contracts/live.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/live-product-surface-architecture.test.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/ReviewPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/review-live-interaction.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/components/LiveMarkdownComposer.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/TaskMessage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/components/LiveImageNode.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/client/live-attachments.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/surface-http/src/live-attachments-http.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/surface-http/src/live-http.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/adapter.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/i18n/zh-CN/task.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/i18n/en-US/task.ts', import.meta.url), 'utf8'),
])
const composerStyles = await readFile(new URL('../packages/web/src/task-session-composer.css', import.meta.url), 'utf8')
const taskComposerView = await readFile(new URL('../packages/web/src/components/TaskSessionComposer.tsx', import.meta.url), 'utf8')
const liveRuntimeDisclosures = await readFile(
  new URL('../packages/web/src/components/LiveRuntimeDisclosures.tsx', import.meta.url),
  'utf8',
)

const liveTaskImplementation = [
  liveTask, liveTaskRuntimeHook, liveTaskHistoryHook, liveTaskActionsHook,
  liveTaskStateHook, liveTaskQueue, liveTaskInput, liveTaskTimeline, liveTaskHistoryWindow,
].join('\n')
// 能力和历史操作已迁移至专属 Hook，门禁覆盖实际所有者。
const reviewImplementation = [reviewPage, await readFile(new URL('../packages/web/src/features/use-review-session.ts', import.meta.url), 'utf8')].join('\n')

const failures = []
const requireText = (source, pattern, label) => {
  if (!pattern.test(source)) failures.push(label)
}
const forbidText = (source, pattern, label) => {
  if (pattern.test(source)) failures.push(label)
}

/* Routes: generic Live Product route stays inside the Task Center shell; one-segment Pi route is compatibility only. */
requireText(app, /path="\/review\/new"/, '缺少通用新建实时任务路由')
requireText(app, /path="\/review\/live\/:liveId\/:runtimeSessionId"[^>]*<TaskCenterPage[^>]*mode="live"/, '通用 Live route 必须由 Task Center 承载')
requireText(app, /path="\/review\/live\/:runtimeSessionId"[^>]*<LegacyLiveTaskRedirect\s*\/>/, '缺少旧 Pi 单段 Live URL 兼容重定向')
requireText(app, /const onLiveTask = location\.pathname === '\/review\/live' \|\| location\.pathname\.startsWith\('\/review\/live\/'\)/, 'App 必须按通用 Live Task 识别实时任务状态')
forbidText(app, /\bonPiLive\b/, 'App 不得恢复 Pi 专属产品级 Live 状态判断')

requireText(taskLiveRuntime, /return `\/review\/live\/\$\{encodeURIComponent\(runtime\.liveId\)\}\/\$\{encodeURIComponent\(runtime\.state\.runtimeSessionId\)\}`/, 'Live runtime href 必须携带 liveId + runtimeSessionId')
requireText(taskLiveRuntime, /liveId:\s*decodeURIComponent\(generic\[1\]!\)/, '通用 Live route 必须解析 liveId')
requireText(taskLiveRuntime, /liveId:\s*'pi'[\s\S]{0,180}runtimeSessionId:\s*decodeURIComponent\(compatibility\[1\]!\)/, '旧单段 Live URL 只能兼容到 Pi')
requireText(legacyRedirect, /to=\{`\/review\/live\/pi\/\$\{encodeURIComponent\(runtimeSessionId\)\}`\}/, 'LegacyLiveTaskRedirect 必须只把旧 URL 映射到 Pi 兼容路由')

/* Task Center only hosts generic Live Product surfaces. */
requireText(taskCenter, /import \{ LiveNewTaskPanel \} from '\.\/LiveNewTaskPanel'/, 'Task Center 必须接入通用 LiveNewTaskPanel')
forbidText(taskCenter, /TaskLiveRuntimeList/, '任务中心侧栏不得恢复独立实时会话列表')
requireText(taskCenter, /TaskCenterMode = 'history' \| 'live' \| 'new' \| 'hub'/, 'Task Center 必须显式承载 Live detail 模式')
requireText(taskCenter, /mode === 'live' && <LiveTaskPage embedded\/>/, '实时任务详情必须内嵌在 Task Center 唯一导航壳层中')
requireText(taskCenter, /mode === 'history' \|\| review\.response \|\| review\.loading/, '历史页仍由 App 负责 P0 Summary，非历史详情才延后补齐任务栏摘要')
requireText(taskCenter, /model\.ensureReview\(\)/, 'Live/New/Hub 冷启动必须能延后补齐历史任务摘要')
requireText(taskCenter, /task-center-list-skeleton/, '任务栏摘要未就绪时必须保留加载占位，不能显示为空列表')
requireText(taskCenter, /mode === 'new' && <LiveNewTaskPanel/, '新建任务必须由通用 LiveNewTaskPanel 承载')
requireText(taskCenter, /onStarted=\{\(liveId, state\) => navigate\(taskLiveRuntimeHref\(\{ liveId, state \}\)\)\}/, '新建 Live 任务后必须进入通用 liveId/runtimeSessionId 路由')
forbidText(taskCenter, /\bpiLiveApi\b|<PiLivePage\b|PiLiveCompatibilityPage/, 'Task Center 不得直接依赖 Pi Live 兼容 Client/Page')

/* Live detail reconciles state without restoring a separate runtime list. */
requireText(liveTaskRuntimeHook, /reconcileState\(shouldRecoverLiveOnVisible\(hiddenForMs, streamDisconnected\)\)/, 'Live 重新可见时必须按断线和时间缺口决定历史快照恢复')
requireText(liveTaskRuntimeHook, /if \(!sameLiveRuntimeState\(previous, runtime\)\)/, 'Live 轻量状态不变时不得重复发布 React State')
forbidText(liveTaskImplementation, /if \(document\.visibilityState === 'visible'\) void reconcileState\(true\)/, '普通标签切换不得无条件强制 Live 快照对账')

/* New Task is capability-driven, not Pi-driven. */
requireText(liveNewTask, /items\.filter\(item => item\.capabilities\.includes\('create'\)\)/, '新建任务只展示声明 create capability 的 Live Product')
requireText(liveNewTask, /void liveApi\.products\(\)/, '新建任务必须从通用 Live Product catalog 读取产品')
requireText(liveNewTask, /const startCapabilities = selectedProduct\?\.startCapabilities/, '新建任务必须消费 startCapabilities')
requireText(liveNewTask, /workspaceSupported = startCapabilities\.workspace !== 'unsupported'/, '工作目录 UI 必须由 workspace capability 驱动')
requireText(liveNewTask, /titleSupported = startCapabilities\.title !== 'unsupported'/, '任务标题 UI 必须由 title capability 驱动')
requireText(liveNewTask, /startCapabilities\.workspace === 'required'/, 'required workspace 必须有前置校验')
requireText(liveNewTask, /if \(workspaceSupported && workspacePath\?\.trim\(\)\) input\.workspacePath = workspacePath\.trim\(\)/, 'workspacePath 只能在能力支持时发送')
requireText(liveNewTask, /if \(titleSupported\)/, 'title 只能在能力支持时发送')
requireText(liveNewTask, /liveApi\.start\(selectedProduct\.liveId, input\)/, '启动必须使用当前选中 Live Product 的 liveId')
requireText(liveNewTask, /onStarted\(selectedProduct\.liveId, state\)/, '启动结果必须保留 liveId')
forbidText(liveNewTask, /\bpiLiveApi\b|\bliveId\s*===\s*['"]pi['"]|\bproductId\s*===\s*['"]pi['"]/, 'LiveNewTaskPanel 不得用 Pi 身份决定产品行为')

/* Live Task controls are capability-driven. */
requireText(liveTaskRuntimeHook, /liveApi\.metadata\(current\.liveId\)/, 'LiveTaskPage 必须按当前 liveId 读取通用 Live Product metadata')
requireText(liveTaskRuntimeHook, /const metadataRequest = liveApi\.metadata\(current\.liveId\)/, 'LiveTaskPage 不得为了单个 Live 任务先拉取完整 Product catalog')
for (const capability of ['stream', 'recovery', 'extension-ui', 'command-discovery', 'workspace-file-reference', 'model-switching', 'thinking-control', 'send', 'steer', 'queue', 'interrupt']) {
  requireText(liveTaskImplementation, new RegExp(`capabilities\\.includes\\(['"]${capability}['"]\\)`), `LiveTaskPage 缺少 capability 驱动：${capability}`)
}
requireText(liveTaskActionsHook, /unsupportedInput\(message, product\.inputCapabilities\)/, 'Live 输入必须由 inputCapabilities 拒绝不支持的输入类型')
requireText(liveTaskActionsHook, /liveApi\.send\(current\.liveId, current\.runtimeSessionId, message, behavior\)/, 'Live send 必须携带 liveId/runtimeSessionId')
requireText(liveTask, /onSubmit=\{\(message, mode\)[\s\S]{0,160}mode === ['"]followUp['"][\s\S]{0,80}['"]follow-up['"]/, 'Live Composer Alt+Enter 必须保持 Follow-up 发送语义')
requireText(liveTaskActionsHook, /liveApi\.interrupt\(current\.liveId, current\.runtimeSessionId\)/, 'Live interrupt 必须携带 liveId/runtimeSessionId')
requireText(liveTaskRuntimeHook, /liveApi\.queueState\(current\.liveId, current\.runtimeSessionId\)/, 'Live queue 恢复必须走通用 Live API')
requireText(liveTaskRuntimeHook, /liveApi\.commands\(current\.liveId, current\.runtimeSessionId\)/, 'Live command discovery 必须走通用 Live API')
requireText(liveTask, /commands=\{commands\}/, 'LiveTaskPage 必须把通用命令目录交给 Composer')
requireText(liveTaskActionsHook, /liveApi\.workspaceFileReferences\(current\.liveId, current\.runtimeSessionId, query, 20\)/, 'Live @文件搜索必须绑定当前 liveId/runtimeSessionId')
requireText(liveTask, /workspaceReferenceSearch=/, 'LiveTaskPage 必须把 Runtime-bound @文件搜索交给 Composer')
requireText(liveComposer, /function WorkspaceReferenceMenuPlugin/, 'Live Composer 必须实现通用 @文件菜单')
requireText(liveComposer, /insertWorkspaceReference/, 'Live Composer @文件必须只插入 Runtime-owned value')
requireText(liveTaskActionsHook, /liveApi\.clearQueue\(current\.liveId, current\.runtimeSessionId\)/, 'Live queue 控制必须走通用 Live API')
requireText(liveTaskRuntimeHook, /normalizedEvent\?\.type === ['"]queue\.update['"]/, 'Live Queue 状态必须消费通用 queue.update 事件')
forbidText(liveTaskImplementation, /\bqueue_update\b/, 'LiveTaskPage 不得解析 Pi 原生 queue_update')
requireText(liveTaskActionsHook, /liveApi\.terminate\(current\.liveId, current\.runtimeSessionId\)/, 'Live terminate 必须携带 liveId/runtimeSessionId')
requireText(liveTaskActionsHook, /liveApi\.respondToExtension\(current\.liveId, current\.runtimeSessionId, extension\.requestId, value\)/, 'Extension UI 回应必须走通用 Live API')
requireText(liveTask, /<TaskSurface\s+mode="live"/, 'LiveTaskPage 必须复用唯一 TaskSurface')
forbidText(liveTaskImplementation, /\bpiLiveApi\b|\bPiLivePage\b|current\.liveId\s*={2,3}\s*['"]pi['"]/, 'LiveTaskPage 不得恢复 Pi 专属产品层判断')
requireText(liveTaskRuntimeHook, /liveApi\.messageActions\(current\.liveId, current\.runtimeSessionId\)/, 'LiveTaskPage 必须通过通用 Contribution 读取消息动作')
requireText(liveTaskActionsHook, /liveApi\.executeMessageAction\(/, 'LiveTaskPage 必须通过通用 Contribution 执行消息动作')
forbidText(liveTaskImplementation, /pi\.edit-from-here|pi\.new-session-from-here|navigateTree|createBranchedSession/, 'LiveTaskPage 不得理解 Pi 私有消息分支语义')
requireText(liveTaskRuntimeHook, /liveApi\.runtimeDisclosures\(current\.liveId, current\.runtimeSessionId\)/, 'LiveTaskPage 必须通过通用 Contribution 读取 Runtime diagnostics')
requireText(liveTaskActionsHook, /liveApi\.executeRuntimeAction\(/, 'LiveTaskPage 必须通过通用 Contribution 执行 Runtime action')
requireText(liveTask, /<LiveRuntimeDisclosures/, 'LiveTaskPage 必须使用 AgentLens-owned Runtime Disclosure renderer')
requireText(liveTask, /<div className="pi-live-document live-task-document">[\s\S]{0,500}<LiveRuntimeDisclosures/, 'Runtime Disclosure 必须位于 Session Document 内，不得创建 TaskSurface 第四结构槽')
requireText(liveTask, /roundProjectorRef\.current\.projectSegmented\(projection\.stable, projection\.active\)/, 'Live 流式投影必须分别输出稳定历史与当前活动轮')
requireText(liveTaskTimeline, /export const GenericLiveRound = memo\(/, 'Live 单轮必须 memo，不能在当前流式 delta 时重绘稳定轮次')
requireText(liveTaskTimeline, /export const StableLiveRounds = memo\(/, 'Live 稳定历史容器必须 memo，流式 delta 时不能再次遍历全部历史')
requireText(liveTask, /from '.\/LiveTaskTimeline'/, 'LiveTaskPage 必须消费唯一通用 Live 轮次渲染组件')
requireText(liveTask, /from '.\/live-task-history-window'/, 'LiveTaskPage 必须复用唯一历史窗口策略')
requireText(liveTask, /rounds=\{roundSegments\.stable\}/, 'Live 稳定历史必须作为独立 Round 段交给 memo 容器')
requireText(liveTask, /roundSegments\.active\.map\(/, 'Live 高频渲染只能直接遍历当前活动 Round')
requireText(liveTask, /snapshotBaseActiveCountRef/, 'Live 完成态必须保留 Snapshot 内活动轮基线，确保增量对账不复制稳定历史')
requireText(liveTaskRuntimeHook, /active:\s*reduceLiveTaskEvent\(previous\.active, envelope\)/, 'Live 高频 SSE 只能更新当前活动轮，不能复制稳定历史')
requireText(liveTaskActionsHook, /active:\s*appendOptimisticLiveUserMessage\([\s\S]{0,160}previous\.active,[\s\S]{0,120}optimisticText,[\s\S]{0,120}optimisticId,[\s\S]{0,120}optimisticAttachments/, '新一轮发送必须把文本与乐观附件一起追加到活动尾部，避免未完成对账时错误推进稳定边界')
requireText(liveTaskRuntimeHook, /mode === ['"]settle['"] && snapshot\.state\.isStreaming/, '上一轮完成对账返回时若下一轮已开始，必须丢弃旧投影结果并保留原 leaf')
requireText(liveTaskStateHook, /const liveTurnRevisionRef = useRef\(0\)/, 'Live 必须记录活动轮修订号，防止旧 Snapshot 覆盖下一轮')
requireText(liveTaskRuntimeHook, /const recoveryTurnRevision = liveTurnRevisionRef\.current/, 'Recovery 发起时必须记录活动轮修订号')
requireText(liveTaskRuntimeHook, /if \(liveTurnRevisionRef\.current !== recoveryTurnRevision\) return/, 'Recovery 返回前若活动轮已变化，必须整体丢弃陈旧结果')
requireText(liveTaskRuntimeHook, /normalizedEvent\.status === ['"]running['"][\s\S]{0,120}liveTurnRevisionRef\.current \+= 1/, 'Runtime 开始新一轮时必须推进活动轮修订号')

requireText(liveTaskRuntimeHook, /let recoveryTask: Promise<void> \| null = null/, 'Live recovery 必须单飞，避免 ready/reconnect/completed 并发打 Snapshot')
requireText(liveTaskRuntimeHook, /let pendingRecoveryMode: ['"]live['"] \| ['"]settle['"] \| null = null/, 'Live recovery 必须记录单飞期间的 pending 恢复')
requireText(liveTaskRuntimeHook, /if \(recoveryTask\)[\s\S]{0,180}pendingRecoveryMode = mode[\s\S]{0,120}return recoveryTask/, 'Live recovery 并发请求必须合并为 pending 补跑')
requireText(liveTaskRuntimeHook, /while \(recoveryActive && nextMode\)[\s\S]{0,220}await recoverOnce\(currentMode\)/, 'Live recovery 必须串行执行 pending 补跑')

requireText(liveTaskRuntimeHook, /if \(product\.capabilities\.includes\(['"]recovery['"]\)\)[\s\S]{0,180}recover\(['"]settle['"]\)[\s\S]{0,260}else[\s\S]{0,220}stable:[\s\S]{0,120}previous\.active/, '没有 recovery capability 的 Live 产品完成后必须直接稳定活动轮')
requireText(liveTaskRuntimeHook, /loadBoundedRecoverySnapshot\(current\.liveId, current\.runtimeSessionId, recoveryLeafId\)/, 'Live 完成/重连对账必须通过有界恢复 helper 使用稳定 leaf')
requireText(liveTaskHistoryWindow, /export async function loadBoundedRecoverySnapshot[\s\S]{0,700}liveApi\.snapshot\([\s\S]{0,180}\{ limit: LIVE_TASK_SNAPSHOT_PAGE_LIMIT \}/, 'Live 恢复每次 Snapshot 必须保持固定有界窗口')
requireText(liveTaskHistoryWindow, /while \(snapshot\.page\?\.hasLater && snapshot\.page\.after\)/, 'Live 恢复存在后续页时必须按 after 有界追平')
forbidText(liveTaskImplementation, /<TaskHeader[\s\S]{0,1800}<LiveRuntimeDisclosures[\s\S]{0,300}<div[\s\S]{0,120}className="pi-live-reader/, 'Runtime Disclosure 不得作为 Header 与 Reader 之间的 TaskSurface 顶层兄弟节点')
forbidText(liveTaskImplementation, /pi\.runtime\.retry|initializationStage|startupResources|runtimeMode|processId/, 'LiveTaskPage 不得解释 Pi 私有 Runtime 诊断字段')
requireText(liveRuntimeDisclosures, /LiveRuntimeDisclosureContributionDto/, 'Runtime Disclosure renderer 必须消费通用 Protocol DTO')
requireText(liveRuntimeDisclosures, /<Dialog[\s\S]{0,120}open=\{diagnosticsOpen\}/, 'Runtime diagnostics 必须使用受控 Dialog placement')
forbidText(liveRuntimeDisclosures, /\bPi\b|pi\.runtime|initializationStage|startupResources|runtimeMode/, 'Runtime Disclosure renderer 不得识别 Pi 私有语义')

requireText(liveStyles, /\.live-task-page\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/, '通用 LiveTaskPage 必须保持单列详情，不得恢复第二套会话导航')
forbidText(liveStyles, /max-width:\s*720px/, 'Live 样式不得引入脱离统一断点体系的 720px 私有断点')
requireText(composerStyles, /@media \(max-width: 767\.98px\)[\s\S]{0,1200}\.task-composer-bar \{ flex-wrap: wrap/, 'Live 窄窗 Composer 控件必须换行，不能横向顶爆')
forbidText(liveTaskImplementation, /pi-live-sessions|pi-live-session-scroll|liveApi\.list\(current\.liveId\)/, 'LiveTaskPage 不得再次持有独立实时会话导航或重复拉取 runtime list')
requireText(liveTaskStateHook, /LiveTaskRoundProjector/, 'LiveTaskPage 必须通过通用增量 Projector 构造语义 Round')
requireText(liveTaskTimeline, /<VirtualRoundMount/, 'LiveTaskPage 必须恢复长会话 Round 虚拟挂载')
requireText(liveTaskRuntimeHook, /new LiveFollowController\(\)/, 'LiveTaskPage 必须恢复流式阅读自动跟随控制')
requireText(liveTask, /pi-live-new-records/, 'LiveTaskPage 必须在用户脱离底部后提供新内容提示')
requireText(liveTask, /<TaskSessionComposer/, 'LiveTaskPage 必须只复用唯一通用输入组件')
requireText(reviewPage, /<TaskSessionComposer/, 'Review 必须复用与 Live 相同的完整输入组件')
requireText(taskComposerView, /<ComposerPillSelect/, '唯一 Composer 必须持有模型/推理控件')
requireText(taskComposerView, /showStreamingModes &&/, '唯一 Composer 必须持有流式消息模式')
forbidText(liveTask, /<LiveMarkdownComposer(?:\s|\/>|>)|<ComposerPillSelect/, 'LiveTaskPage 不得重建编辑器或选择器')
requireText(liveTask, /composerExpanded/, 'LiveTaskPage 必须保留通用输入区展开/收起能力')
requireText(liveTask, /startupQueued/, 'LiveTaskPage 必须保留 Runtime 初始化期首条消息暂存')
requireText(liveTask, /interruptNotice/, 'LiveTaskPage 必须保留中断成功反馈')
requireText(liveTaskTimeline, /attachments=\{item\.attachments\}/, 'LiveTaskPage 必须把 Snapshot 附件交给共享 TaskMessage')
requireText(liveTaskProjection, /projectLiveTaskRounds/, 'Live Product 投影必须提供语义 Round')
requireText(liveTaskProjection, /One semantic user turn must have exactly one Process disclosure/, 'Live 一个语义轮只允许一个 Process，不得按事实切分产生重复过程块')
requireText(liveTaskProjection, /return raw\.map\(round => \(\{[\s\S]{0,140}buildRoundModel\(round\.items/, 'Live 必须将语义轮次直接传入统一 Process 模型，不得人为拆分')
requireText(liveTaskProjection, /class LiveTaskRoundProjector/, 'Live 投影必须缓存稳定历史，不能每个流式批次重算全部会话')
requireText(liveTaskProjection, /projectSegmented\([\s\S]{0,260}stableItems[\s\S]{0,260}activeItems/, 'Live Round Projector 必须直接返回稳定历史 / 活动轮两个独立段')
requireText(liveTaskProjection, /stable:\s*this\.stableRounds,[\s\S]{0,180}active:\s*activeItems\.length/, 'Live Projector 必须复用稳定 Round 数组引用，只重算活动 Round')
requireText(liveTaskProjection, /for \(let index = items\.length - 1; index >= 0; index -= 1\)/, 'Live 活动轮更新必须从尾部定位当前流式节点')
requireText(liveTaskProjection, /function mergeLiveActiveProjectionItems[\s\S]{0,500}if \(indexes\.has\(item\.id\)\) continue/, '重连 Snapshot 不得覆盖同 ID 的更新实时节点')
requireText(liveTaskProjection, /candidate\.id\.startsWith\(['"]user:['"]\)[\s\S]{0,140}candidate\.text === item\.text/, '重连 Snapshot 必须把持久化用户消息与乐观占位对账')
requireText(liveTaskActionsHook, /settleLiveTaskProjectionItems\(previous\.active\)/, '手动 Stop 后必须立即收束活动轮展示状态')
requireText(liveTaskProjection, /liveTaskStableRoundPrefixLength/, 'Live 必须区分稳定历史与当前流式语义轮次')
requireText(liveTaskProjection, /liveEventChangesTaskTranscript/, 'Live 必须区分正文事件与控制事件，避免无意义正文重算')
requireText(liveTaskRuntimeHook, /if \(liveEventChangesTaskTranscript\(envelope\.normalizedEvent\)\)/, 'Live SSE 控制事件不得触发正文 setItems')
requireText(taskLiveRuntime, /event\.type === ['"]title\.update['"]/, 'LiveTaskPage 必须实时消费通用 title.update')
requireText(liveTaskRuntimeHook, /normalizedEvent\?\.type === ['"]control\.changed['"]/, 'LiveTaskPage 必须通过通用 control.changed 即时刷新 Runtime controls')
requireText(liveTaskRuntimeHook, /normalizedEvent\?\.type === ['"]runtime-disclosure\.changed['"]/, 'LiveTaskPage 必须通过通用失效事件刷新 Runtime Disclosure')
requireText(liveClient, /event\.type === ['"]runtime-disclosure\.changed['"][\s\S]{0,120}return ['"]runtime-disclosure\.changed['"]/, 'Runtime Disclosure 失效通知必须在调度器中合并')

requireText(liveTaskRuntimeHook, /setActivityStatus\(envelope\.normalizedEvent\.status\)/, 'LiveTaskPage 必须消费 compacting 等通用活动状态')
requireText(taskLiveRuntime, /event\.status === ['"]failed['"] \|\| event\.status === ['"]terminating['"] \|\| event\.status === ['"]terminated['"]/, 'Live 终止/失败状态必须清理 isStreaming，不能继续显示可中断')
requireText(liveTaskRuntimeHook, /normalizedEvent\.status === ['"]failed['"] && envelope\.normalizedEvent\.message[\s\S]{0,120}setError/, 'Live failed status 必须把 Runtime 原因反馈给用户')
requireText(liveTaskRuntimeHook, /normalizedEvent\?\.type === ['"]completed['"][\s\S]{0,260}normalizedEvent\.status === ['"]failed['"][\s\S]{0,120}setError/, 'Live completed failed 必须把 Run 失败原因反馈给用户')

requireText(liveTaskProjection, /semanticId:\s*id/, 'Live Round 的 semanticId 必须等于语义轮次自身 ID')
requireText(liveTaskProjection, /id:\s*`live-round:\$\{item\.id\}`/, 'Live 用户消息必须开启稳定语义轮 ID，不能按工具调用生成新轮')
requireText(liveTaskProjection, /type === 'thinking' \|\| type === 'reasoning'/, 'Live Snapshot 投影不得在刷新后丢失 Thinking')
requireText(liveTaskProjection, /type === 'toolCall' \|\| type === 'tool_call'/, 'Live Snapshot 投影不得在刷新后丢失 Tool')
requireText(liveTaskProjection, /reviewMessageAttachmentsFromPayload/, 'Live Snapshot 投影不得在刷新后丢失图片附件')
requireText(liveTaskInput, /URL\.createObjectURL\(await response\.blob\(\)\)/, '图片发送前必须生成独立 Web 本地乐观预览')
requireText(taskMessage, /previewUrl\?: string/, 'TaskMessage 本地表现模型必须允许 Web-only previewUrl')
requireText(taskMessage, /URL\.revokeObjectURL\(attachment\.previewUrl\)/, 'TaskMessage 卸载或替换乐观图片时必须释放 blob URL')
requireText(liveTaskActionsHook, /optimisticMessageAttachments\(message\)/, 'Live 正常发送必须为通用附件建立乐观表现')
requireText(liveTaskInput, /part is Extract<LiveMessageDto\['parts'\]\[number\], \{ type: ['"]image['"] \| ['"]file['"] \}>/, '乐观附件必须显式收窄 image/file part')
requireText(taskMessage, /attachment\.type === ['"]file['"]/, 'TaskMessage 必须展示通用文件附件，不能只显示图片')
requireText(zhTaskLocale, /fileAttachment:\s*['"]文件附件['"]/, '缺少文件附件中文文案')
requireText(enTaskLocale, /fileAttachment:\s*['"]File attachment['"]/, '缺少文件附件英文文案')


/* Generic client/protocol remain the only product-level API vocabulary. */
requireText(liveClient, /const LIVE_ROOT = '\/api\/v1\/live'/, '通用 Live Client 根路径必须保持 /api/v1/live')
requireText(liveClient, /class LiveEventScheduler/, '通用 Live Client 必须在正式 SSE 链路保留展示背压调度')
requireText(liveClient, /LIVE_VISIBLE_FLUSH_MS\s*=\s*48/, '前台 Live delta 必须保持小批次合并，不能逐 token 触发 React')
requireText(liveClient, /LIVE_HIDDEN_FLUSH_MS\s*=\s*250/, '后台 Live 必须降频，不能按前台频率持续渲染')
requireText(liveClient, /scheduler\.push\(JSON\.parse\(event\.data\) as LiveRuntimeEventDto\)/, 'EventSource 必须先进入通用 Live 调度器再交给页面')
requireText(liveClient, /existing === this\.queue\.length - 1/, 'Live 展示背压只能合并相邻事件，不能跨 Tool/Status 边界重排事实')
requireText(liveClient, /visibilitychange/, 'Live 调度器必须响应 Page Visibility')
requireText(liveClient, /scheduler\.dispose\(\)/, 'Live 页面离开时必须释放调度队列')
requireText(liveClient, /async products\(\): Promise<LiveProductDto\[]>/, '通用 Live Client 必须提供 products')
requireText(liveClient, /async knownRuntimes\(\): Promise<LiveRuntimeRefDto\[]>/, '通用 Live Client 必须聚合各 Live Product runtimes')
requireText(liveClient, /start\(liveId: string, input: LiveStartInputDto = \{\}\)/, 'Live Client start 必须显式接收 liveId')
requireText(liveClient, /resume\(liveId: string, logicalSessionId: string\)/, 'Live Client resume 必须显式接收 liveId')
requireText(liveClient, /fork\(liveId: string, logicalSessionId: string\)/, 'Live Client fork 必须显式接收 liveId')
requireText(liveClient, /queueState\(liveId: string, runtimeSessionId: string\)/, 'Live Client 必须提供通用 queue state')
requireText(liveClient, /async commands\(liveId: string, runtimeSessionId: string\): Promise<LiveCommandDto\[]>/, 'Live Client 必须提供通用 command discovery')
requireText(liveClient, /async messageActions\([\s\S]{0,180}LiveMessageActionContributionDto\[]>/, 'Live Client 必须提供受控消息动作 Contribution 读取')
requireText(liveClient, /executeMessageAction\([\s\S]{0,260}actionId: string[\s\S]{0,260}targetEntryId: string/, 'Live Client 必须用 opaque actionId + stable targetEntryId 执行消息动作')
requireText(liveClient, /async runtimeDisclosures\([\s\S]{0,180}LiveRuntimeDisclosureContributionDto\[]>/, 'Live Client 必须提供受控 Runtime Disclosure 读取')
requireText(liveClient, /executeRuntimeAction\([\s\S]{0,220}actionId: string/, 'Live Client Runtime action 必须只回传 opaque actionId')
requireText(liveClient, /clearQueue\(liveId: string, runtimeSessionId: string\)/, 'Live Client 必须提供通用 queue control')

for (const capability of ['create', 'send', 'stream', 'interrupt', 'queue', 'steer', 'model-switching', 'thinking-control', 'extension-ui', 'command-discovery', 'recovery', 'resume', 'fork']) {
  requireText(liveProtocol, new RegExp(`\\| '${capability}'`), `Live protocol capability 缺少：${capability}`)
}
requireText(liveProtocol, /export interface LiveCommandDto[\s\S]{0,220}value:\s*string[\s\S]{0,220}group\?:\s*string/, 'LiveCommandDto 必须保持 Runtime-owned value 与可选 group')
requireText(liveProtocol, /export interface LiveMessageActionContributionDto[\s\S]{0,420}actionId:\s*string[\s\S]{0,420}roles:\s*Array<['"]user['"] \| ['"]assistant['"]>/, '受控消息动作必须保持 opaque actionId + role 声明')
requireText(liveProtocol, /export interface LiveMessageActionResultDto[\s\S]{0,300}outcome:\s*['"]refresh-current['"] \| ['"]open-runtime['"]/, '消息动作结果只能返回受控导航结果')
requireText(liveProtocol, /export interface LiveRuntimeDisclosureContributionDto[\s\S]{0,520}contributionId:\s*string[\s\S]{0,520}fields:\s*LiveRuntimeContributionFieldDto\[]/, 'Runtime Disclosure 必须保持声明式字段契约')
requireText(liveCore, /export interface LiveRuntimeState[\s\S]{0,420}title\?:\s*string/, 'Core LiveRuntimeState 必须保留 Agent-neutral 任务标题')
requireText(liveProtocol, /export interface LiveRuntimeStateDto[\s\S]{0,180}title\?:\s*string/, 'Protocol LiveRuntimeStateDto 必须暴露通用任务标题')
requireText(liveCore, /type:\s*['"]title\.update['"][\s\S]{0,80}title:\s*string/, 'Core LiveEvent 必须包含通用 title.update')
requireText(liveCore, /type:\s*['"]control\.changed['"][\s\S]{0,100}control:\s*['"]model['"] \| ['"]thinking['"]/, 'Core LiveEvent 必须包含通用 control.changed')
requireText(liveProtocol, /type:\s*['"]title\.update['"];\s*title:\s*string/, 'Protocol LiveEventDto 必须包含通用 title.update')
requireText(liveProtocol, /type:\s*['"]control\.changed['"];\s*control:\s*['"]model['"] \| ['"]thinking['"]/, 'Protocol LiveEventDto 必须包含通用 control.changed')
requireText(liveProtocol, /type:\s*['"]runtime-disclosure\.changed['"]/, 'Protocol LiveEventDto 必须包含 Runtime Disclosure 失效事件')
requireText(piLiveAdapter, /type === ['"]task_summary['"][\s\S]{0,180}type:\s*['"]title\.update['"]/, 'Pi task_summary 必须只在 Adapter 边界映射为通用 title.update')
requireText(piLiveAdapter, /type === ['"]model_changed['"][\s\S]{0,120}control:\s*['"]model['"]/, 'Pi model_changed 必须只在 Adapter 边界映射为通用 control.changed')
requireText(piLiveAdapter, /type === ['"]thinking_level_changed['"][\s\S]{0,120}control:\s*['"]thinking['"]/, 'Pi thinking_level_changed 必须只在 Adapter 边界映射为通用 control.changed')
requireText(piLiveAdapter, /type === ['"]runtime_exit['"][\s\S]{0,180}type:\s*['"]status['"][\s\S]{0,120}status:\s*['"]failed['"]/, 'Pi runtime_exit 必须映射为终止性 failed status，不能与扩展错误混为一谈')
requireText(piLiveAdapter, /type === ['"]extension_error['"][\s\S]{0,180}type:\s*['"]error['"]/, 'Pi extension_error 必须保留为非终止性通用 error')
requireText(piLiveAdapter, /type === ['"]runtime_resources['"][\s\S]{0,180}runtime-disclosure\.changed/, 'Pi 私有诊断变化必须只在 Adapter 边界映射为 Runtime Disclosure 失效事件')
requireText(liveHttp, /const title = typeof row\.title === ['"]string['"]/, 'Live HTTP 必须安全投影通用 Runtime title')
requireText(liveTask, /state\?\.title\?\.trim\(\) \|\| workspace/, 'Live 页头必须优先展示通用任务标题')
requireText(liveProtocol, /export interface LiveRuntimeActionResultDto[\s\S]{0,180}runtime:\s*LiveRuntimeStateDto/, 'Runtime action 只能返回通用 Runtime state')
requireText(liveProtocol, /export interface LiveProductDto[\s\S]{0,500}liveId:\s*string[\s\S]{0,500}capabilities:\s*LiveCapabilityNameDto\[\][\s\S]{0,500}inputCapabilities:\s*LiveInputCapabilitiesDto[\s\S]{0,500}startCapabilities:\s*LiveStartCapabilitiesDto/, 'LiveProductDto 必须保持 capability/input/start 三层产品契约')

/* Live input/composer behavior is product-level, not Pi-specific. */
requireText(liveComposer, /KEY_ENTER_COMMAND/, 'Live Composer 缺少 Enter command 边界')
requireText(liveComposer, /PASTE_COMMAND/, 'Live Composer 缺少统一粘贴 command')
requireText(liveComposer, /LiveLargeTextNode/, 'Live Composer 缺少结构化大文本节点')
requireText(liveComposer, /LiveImageNode/, 'Live Composer 缺少结构化图片节点')
requireText(liveComposer, /function ImagePastePlugin/, 'Live Composer 缺少图片粘贴边界')
requireText(liveComposer, /uploadLiveAttachment\(item\.file, item\.attachmentId\)/, '图片必须先进入通用 Live Attachment Service')
requireText(liveComposer, /pendingCountRef\.current \+= pending\.length/, '并发附件上传必须保持有界发送锁')
requireText(liveComposer, /globalThis\.crypto\.randomUUID\(\)/, '图片粘贴必须先生成 opaque attachmentId')
requireText(liveComposer, /getMessage\(\)/, 'Live Composer 必须输出统一结构化消息')
requireText(liveComposer, /event\.isComposing/, 'Live Composer 缺少 IME isComposing 保护')
requireText(liveComposer, /keyCode === 229/, 'Live Composer 缺少 IME 229 兼容')
requireText(liveComposer, /function ExternalDraftPlugin/, 'Live Composer 缺少外部 Draft revision 边界')
requireText(liveComposer, /editor\.isComposing\(\)/, '外部 Draft 同步不得打断 IME')
requireText(liveComposer, /function DraftPresencePlugin/, 'Live Composer 本地编辑必须只向父级传播轻量 presence')
requireText(liveComposer, /function CommandMenuPlugin/, 'Live Composer 缺少 Slash 命令面板')
requireText(liveComposer, /COMMAND_PRIORITY_CRITICAL/, 'Slash 命令面板必须优先于历史导航与发送快捷键')
requireText(liveComposer, /replacePlainTextDocument\(editor, `\$\{command\.value\} `\)/, 'Slash 命令必须原样插入 Runtime-owned value')
requireText(liveComposer, /className="select-menu-popover live-command-menu"/, 'Slash 命令面板必须复用 SelectMenu 视觉规范')
forbidText(liveComposer, /BUILTIN_SLASH_COMMANDS|get_commands|Pi Live/, 'Live Composer 不得硬编码 Pi / Built-in 命令语义')
requireText(liveComposer, /function DraftPersistencePlugin/, 'Live Composer 必须在内部处理 Session 草稿持久化')
requireText(liveComposer, /writeLiveComposerDraft\(pending\.key, draftTextFromEditor\(pending\.state\)\)/, 'Live Composer 草稿持久化不得依赖父页面全文状态')
requireText(liveComposer, /KEY_ARROW_UP_COMMAND/, 'Live Composer 输入历史缺少 ArrowUp')
requireText(liveComposer, /KEY_ARROW_DOWN_COMMAND/, 'Live Composer 输入历史缺少 ArrowDown')
requireText(liveComposer, /historyNavigatorRef\.current\.previous/, 'Live Composer ArrowUp 必须通过历史导航状态机')
requireText(liveComposer, /event\.isComposing/, 'Live Composer 输入历史必须避开 IME composition')
requireText(liveComposer, /event\.keyCode !== 229/, 'Live Composer 输入历史必须保留 IME 229 边界')
requireText(liveComposer, /restoreMessageBeforeCurrentDraft/, 'Live Composer 发送失败必须支持原消息恢复')
requireText(liveComposer, /export const LiveMarkdownComposer = memo\(LiveMarkdownComposerImpl\)/, 'Live Composer 必须与阅读区父级渲染隔离')
requireText(liveImageNode, /getImagePart\(\): LiveImagePartDto \| null/, 'Live Image Node 必须输出统一 image part')
requireText(liveImageNode, /liveAttachmentPreviewUrl\(attachmentId\)/, '图片预览必须使用 opaque attachmentId')
requireText(liveAttachmentClient, /\/api\/v1\/live\/attachments/, 'Web 图片上传必须使用通用 Live attachment 端点')
requireText(liveAttachmentHttp, /LIVE_ATTACHMENT_MAX_ITEM_BYTES/, 'Live Attachment HTTP 必须保持单项大小上限')
requireText(liveTask, /draft=\{draft\}/, 'LiveTaskPage 必须通过显式 Draft revision 控制 Composer')
requireText(liveTask, /liveComposerDraftKey\(current\.liveId, current\.runtimeSessionId\)/, 'Live 草稿必须按 liveId + runtimeSessionId 隔离')
requireText(liveTask, /readLiveComposerDraft\(composerDraftKey\)/, 'LiveTaskPage 必须在 Session 切换时恢复草稿')
requireText(liveTask, /draftKey=\{composerDraftKey \|\| undefined\}/, 'LiveTaskPage 必须把 Session 草稿 key 交给 Composer 内部持久化')
requireText(liveTask, /inputHistory=\{inputHistory\}/, 'LiveTaskPage 必须把 Session 输入历史交给 Composer')
requireText(liveTaskActionsHook, /setInputHistory\(previous => appendLiveInputHistory\(previous, optimisticText\)\)/, '成功发送后必须追加输入历史')
requireText(liveTaskActionsHook, /composerRef\.current\?\.restoreMessage\(message\)/, '发送失败必须恢复原提交内容')
requireText(liveTask, /onDraftPresenceChange=\{setComposerHasContent\}/, 'LiveTaskPage 只能消费轻量内容存在性')
forbidText(liveTaskImplementation, /onDraftChange=/, 'LiveTaskPage 不得接收每次按键的完整草稿')
requireText(liveTask, /onAttachmentPendingChange=\{setComposerAttachmentPending\}/, 'LiveTaskPage 必须感知附件上传 pending')
requireText(liveTask, /canSubmit=\{canSubmit\}/, 'LiveTaskPage 必须传入 capability/pending 限制')
requireText(liveTask, /hasContent=\{composerHasContent\}/, 'LiveTaskPage 必须传入输入存在性')
requireText(taskComposerView, /disabled=\{!editorProps\.canSubmit \|\| !hasContent\}/, '唯一 Composer 发送按钮必须受 capability/pending/content 联合约束')

/* Historical Review actions are also product/capability projections, never source-id checks. */
requireText(reviewImplementation, /projectReviewLiveInteraction\(detail, liveProducts\)/, 'Review 必须通过通用 Live Product 投影恢复/分叉能力')
requireText(reviewImplementation, /const liveId = detailLiveInteraction\.liveId[\s\S]*?const historicalId = detail\.id[\s\S]*?liveApi\.resume\(liveId, historicalId\)/, 'Review resume 必须走通用 liveId')
requireText(reviewImplementation, /const liveId = detailLiveInteraction\.liveId[\s\S]*?liveApi\.forkAt\(liveId, detail\.id, nativeEventId\)/, 'Review 指定轮次 fork-at 必须走通用 liveId 与原生 event ID')
forbidText(reviewImplementation, /sourceIds\.includes\(['"]pi['"]\)[\s\S]{0,500}(?:continueSession|forkContinue)/, 'Review 不得再通过 Pi sourceId 决定历史继续能力')
requireText(reviewLiveInteraction, /product\.productId === session\.productId/, 'Review Live 能力必须按 productId 匹配')
requireText(reviewLiveInteraction, /product\.capabilities\.includes\('resume'\)/, 'Review resume 必须来自 capability')
requireText(reviewLiveInteraction, /product\.capabilities\.includes\('fork-at'\)/, 'Review fork-at 必须来自 capability')

/* Keep the architecture anti-regression test itself alive. */
requireText(architectureTest, /统一 Product Surface 不直接依赖 Pi Live 兼容 Client 或页面/, '缺少 Product Surface 去 Pi 专属依赖回归测试')
requireText(architectureTest, /LiveTask 高级交互只消费通用 capability 与 control/, '缺少 LiveTask capability 架构回归测试')

/* Slash command discovery crosses generic HTTP/adapter boundaries only. */
requireText(liveHttp, /action === 'message-actions' && request\.method === 'GET'/, 'Live HTTP 缺少声明式 message-actions GET')
requireText(liveHttp, /action === 'message-actions' && request\.method === 'POST'/, 'Live HTTP 缺少受控 message-actions POST')
requireText(liveHttp, /action === 'runtime-disclosures' && request\.method === 'GET'/, 'Live HTTP 缺少声明式 runtime-disclosures GET')
requireText(liveHttp, /action === 'runtime-actions' && request\.method === 'POST'/, 'Live HTTP 缺少受控 runtime-actions POST')
requireText(liveHttp, /normalizeRuntimeDisclosures/, 'Live HTTP 必须归一化并限制 Runtime Contributions')
requireText(liveHttp, /normalizePublicRuntimeState/, '通用 Live HTTP 必须过滤 Adapter 私有 Runtime state')
requireText(liveHttp, /Live runtime action is not currently declared by this adapter/, 'Runtime action 执行前必须重新检查 Adapter 当前声明')
requireText(liveHttp, /action === 'commands' && request\.method === 'GET'/, 'Live HTTP 缺少通用 commands GET')
requireText(liveHttp, /requireCapability\(adapter, 'command-discovery'\)/, 'Live commands HTTP 必须由 command-discovery capability 驱动')
requireText(piLiveAdapter, /'command-discovery'/, 'Pi Live Adapter 必须显式声明 command-discovery')
requireText(piLiveAdapter, /async commands\(runtimeSessionId: string\)/, 'Pi Live Adapter 必须把 Runtime 命令投影为通用 LiveCommand')
requireText(piLiveAdapter, /value: `\/\$\{command\.name\}`/, 'Pi Live Adapter 必须在 Adapter 边界生成可发送 Slash value')
forbidText(liveTaskImplementation, /get_commands|BUILTIN_SLASH_COMMANDS/, 'Product Surface 不得依赖 Pi get_commands / Built-in 命令')

/* AgentLens-owned command menu copy must exist in both official locales. */
requireText(zhTaskLocale, /commandMenu:[\s\S]{0,100}aria:\s*'可用命令'/, '缺少 Slash 命令中文文案')
requireText(enTaskLocale, /commandMenu:[\s\S]{0,100}aria:\s*'Available commands'/, '缺少 Slash 命令英文文案')

if (failures.length) {
  console.error('Live Product 表现层契约检查失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('Live Product 表现层契约检查通过：通用路由、Live catalog、能力驱动 New Task/Live Task、历史任务侧栏、Review resume/fork 与 Pi 兼容边界均已锁定。')
