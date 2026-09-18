import { readFile } from 'node:fs/promises'

const [
  app,
  taskCenter,
  taskLiveRuntimeList,
  taskLiveRuntime,
  legacyRedirect,
  liveNewTask,
  liveTask,
  liveTaskProjection,
  liveStyles,
  liveClient,
  liveProtocol,
  architectureTest,
  reviewPage,
  reviewLiveInteraction,
  liveComposer,
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
  readFile(new URL('../packages/web/src/features/TaskLiveRuntimeList.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/task-live-runtime.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/LegacyLiveTaskRedirect.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/LiveNewTaskPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/LiveTaskPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/live-task-projection.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/pi-live.css', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/client/live.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/protocol/src/live.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/live-product-surface-architecture.test.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/ReviewPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/review-live-interaction.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/components/LiveMarkdownComposer.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/components/LiveImageNode.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/client/live-attachments.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/surface-http/src/live-attachments-http.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/surface-http/src/live-http.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/adapter.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/i18n/zh-CN/task.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/i18n/en-US/task.ts', import.meta.url), 'utf8'),
])

const failures = []
const requireText = (source, pattern, label) => {
  if (!pattern.test(source)) failures.push(label)
}
const forbidText = (source, pattern, label) => {
  if (pattern.test(source)) failures.push(label)
}

/* Routes: generic Live Product route is the primary route; one-segment Pi route is compatibility only. */
requireText(app, /path="\/review\/new"/, '缺少通用新建实时任务路由')
requireText(app, /path="\/review\/live\/:liveId\/:runtimeSessionId"[^>]*<LiveTaskPage\s*\/>/, '缺少通用 LiveTaskPage 路由')
requireText(app, /path="\/review\/live\/:runtimeSessionId"[^>]*<LegacyLiveTaskRedirect\s*\/>/, '缺少旧 Pi 单段 Live URL 兼容重定向')
requireText(app, /const onLiveTask = location\.pathname === '\/review\/live' \|\| location\.pathname\.startsWith\('\/review\/live\/'\)/, 'App 必须按通用 Live Task 识别实时任务状态')
forbidText(app, /\bonPiLive\b/, 'App 不得恢复 Pi 专属产品级 Live 状态判断')

requireText(taskLiveRuntime, /return `\/review\/live\/\$\{encodeURIComponent\(runtime\.liveId\)\}\/\$\{encodeURIComponent\(runtime\.state\.runtimeSessionId\)\}`/, 'Live runtime href 必须携带 liveId + runtimeSessionId')
requireText(taskLiveRuntime, /liveId:\s*decodeURIComponent\(generic\[1\]!\)/, '通用 Live route 必须解析 liveId')
requireText(taskLiveRuntime, /liveId:\s*'pi'[\s\S]{0,180}runtimeSessionId:\s*decodeURIComponent\(compatibility\[1\]!\)/, '旧单段 Live URL 只能兼容到 Pi')
requireText(legacyRedirect, /to=\{`\/review\/live\/pi\/\$\{encodeURIComponent\(runtimeSessionId\)\}`\}/, 'LegacyLiveTaskRedirect 必须只把旧 URL 映射到 Pi 兼容路由')

/* Task Center only hosts generic Live Product surfaces. */
requireText(taskCenter, /import \{ LiveNewTaskPanel \} from '\.\/LiveNewTaskPanel'/, 'Task Center 必须接入通用 LiveNewTaskPanel')
requireText(taskCenter, /import \{ TaskLiveRuntimeList \} from '\.\/TaskLiveRuntimeList'/, 'Task Center 必须使用通用实时任务列表')
requireText(taskCenter, /<TaskLiveRuntimeList\s*\/>/, '任务列表必须展示通用 Live runtimes')
requireText(taskCenter, /mode === 'new' && <LiveNewTaskPanel/, '新建任务必须由通用 LiveNewTaskPanel 承载')
requireText(taskCenter, /onStarted=\{\(liveId, state\) => navigate\(taskLiveRuntimeHref\(\{ liveId, state \}\)\)\}/, '新建 Live 任务后必须进入通用 liveId/runtimeSessionId 路由')
forbidText(taskCenter, /\bpiLiveApi\b|<PiLivePage\b|PiLiveCompatibilityPage/, 'Task Center 不得直接依赖 Pi Live 兼容 Client/Page')

/* Running task rail discovers every Live Product through the generic client. */
requireText(taskLiveRuntimeList, /liveApi\.knownRuntimes\(\)/, '实时任务列表必须通过通用 liveApi 发现 runtimes')
requireText(taskLiveRuntimeList, /item\.liveId[\s\S]{0,120}item\.state\.runtimeSessionId/, '实时任务列表 key/identity 必须包含 liveId + runtimeSessionId')
requireText(taskLiveRuntimeList, /navigate\(taskLiveRuntimeHref\(item\)\)/, '实时任务列表必须进入通用 Live route')
requireText(taskLiveRuntimeList, /agent-lens:live-state-changed/, '实时任务列表必须监听通用 Live 状态变化事件')

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
requireText(liveTask, /void liveApi\.products\(\)/, 'LiveTaskPage 必须读取通用 Live Product catalog')
requireText(liveTask, /products\.find\(item => item\.liveId === current\.liveId\)/, 'LiveTaskPage 必须按当前 liveId 匹配产品')
for (const capability of ['stream', 'recovery', 'extension-ui', 'command-discovery', 'model-switching', 'thinking-control', 'send', 'steer', 'queue', 'interrupt']) {
  requireText(liveTask, new RegExp(`capabilities\\.includes\\(['"]${capability}['"]\\)`), `LiveTaskPage 缺少 capability 驱动：${capability}`)
}
requireText(liveTask, /unsupportedInput\(message, product\.inputCapabilities\)/, 'Live 输入必须由 inputCapabilities 拒绝不支持的输入类型')
requireText(liveTask, /liveApi\.send\(current\.liveId, current\.runtimeSessionId, message, behavior\)/, 'Live send 必须携带 liveId/runtimeSessionId')
requireText(liveTask, /onSubmit=\{\(message, mode\)[\s\S]{0,160}mode === ['"]followUp['"][\s\S]{0,80}['"]follow-up['"]/, 'Live Composer Alt+Enter 必须保持 Follow-up 发送语义')
requireText(liveTask, /liveApi\.interrupt\(current\.liveId, current\.runtimeSessionId\)/, 'Live interrupt 必须携带 liveId/runtimeSessionId')
requireText(liveTask, /liveApi\.queueState\(current\.liveId, current\.runtimeSessionId\)/, 'Live queue 恢复必须走通用 Live API')
requireText(liveTask, /liveApi\.commands\(current\.liveId, current\.runtimeSessionId\)/, 'Live command discovery 必须走通用 Live API')
requireText(liveTask, /commands=\{commands\}/, 'LiveTaskPage 必须把通用命令目录交给 Composer')
requireText(liveTask, /liveApi\.clearQueue\(current\.liveId, current\.runtimeSessionId\)/, 'Live queue 控制必须走通用 Live API')
requireText(liveTask, /normalizedEvent\?\.type === ['"]queue\.update['"]/, 'Live Queue 状态必须消费通用 queue.update 事件')
forbidText(liveTask, /\bqueue_update\b/, 'LiveTaskPage 不得解析 Pi 原生 queue_update')
requireText(liveTask, /liveApi\.terminate\(current\.liveId, current\.runtimeSessionId\)/, 'Live terminate 必须携带 liveId/runtimeSessionId')
requireText(liveTask, /liveApi\.respondToExtension\(current\.liveId, current\.runtimeSessionId, extension\.requestId, value\)/, 'Extension UI 回应必须走通用 Live API')
requireText(liveTask, /<TaskSurface\s+mode="live"/, 'LiveTaskPage 必须复用唯一 TaskSurface')
forbidText(liveTask, /\bpiLiveApi\b|\bPiLivePage\b|current\.liveId\s*={2,3}\s*['"]pi['"]/, 'LiveTaskPage 不得恢复 Pi 专属产品层判断')

requireText(liveStyles, /grid-template-columns:\s*var\(--pi-live-side\)\s+minmax\(0,\s*1fr\)/, 'Live 页面桌面壳层必须保留会话栏 + 主区两列')
requireText(liveTask, /<aside className="pi-live-sessions"/, 'LiveTaskPage 两列壳层必须实际渲染通用会话栏')
requireText(liveTask, /setRuntimes\(matched\.runtimes\)/, 'Live 会话栏必须来自当前 Live Product runtimes')
requireText(liveTask, /projectLiveTaskRounds\(items\)/, 'LiveTaskPage 必须恢复语义 Round 投影')
requireText(liveTask, /<VirtualRoundMount/, 'LiveTaskPage 必须恢复长会话 Round 虚拟挂载')
requireText(liveTask, /new LiveFollowController\(\)/, 'LiveTaskPage 必须恢复流式阅读自动跟随控制')
requireText(liveTask, /pi-live-new-records/, 'LiveTaskPage 必须在用户脱离底部后提供新内容提示')
requireText(liveTask, /composerExpanded/, 'LiveTaskPage 必须保留通用输入区展开/收起能力')
requireText(liveTask, /startupQueued/, 'LiveTaskPage 必须保留 Runtime 初始化期首条消息暂存')
requireText(liveTask, /interruptNotice/, 'LiveTaskPage 必须保留中断成功反馈')
requireText(liveTask, /attachments=\{item\.attachments\}/, 'LiveTaskPage 必须把 Snapshot 附件交给共享 TaskMessage')
requireText(liveTaskProjection, /projectLiveTaskRounds/, 'Live Product 投影必须提供语义 Round')
requireText(liveTaskProjection, /type === 'thinking' \|\| type === 'reasoning'/, 'Live Snapshot 投影不得在刷新后丢失 Thinking')
requireText(liveTaskProjection, /type === 'toolCall' \|\| type === 'tool_call'/, 'Live Snapshot 投影不得在刷新后丢失 Tool')
requireText(liveTaskProjection, /reviewMessageAttachmentsFromPayload/, 'Live Snapshot 投影不得在刷新后丢失图片附件')

/* Generic client/protocol remain the only product-level API vocabulary. */
requireText(liveClient, /const LIVE_ROOT = '\/api\/v1\/live'/, '通用 Live Client 根路径必须保持 /api/v1/live')
requireText(liveClient, /async products\(\): Promise<LiveProductDto\[]>/, '通用 Live Client 必须提供 products')
requireText(liveClient, /async knownRuntimes\(\): Promise<LiveRuntimeRefDto\[]>/, '通用 Live Client 必须聚合各 Live Product runtimes')
requireText(liveClient, /start\(liveId: string, input: LiveStartInputDto = \{\}\)/, 'Live Client start 必须显式接收 liveId')
requireText(liveClient, /resume\(liveId: string, logicalSessionId: string\)/, 'Live Client resume 必须显式接收 liveId')
requireText(liveClient, /fork\(liveId: string, logicalSessionId: string\)/, 'Live Client fork 必须显式接收 liveId')
requireText(liveClient, /queueState\(liveId: string, runtimeSessionId: string\)/, 'Live Client 必须提供通用 queue state')
requireText(liveClient, /async commands\(liveId: string, runtimeSessionId: string\): Promise<LiveCommandDto\[]>/, 'Live Client 必须提供通用 command discovery')
requireText(liveClient, /clearQueue\(liveId: string, runtimeSessionId: string\)/, 'Live Client 必须提供通用 queue control')

for (const capability of ['create', 'send', 'stream', 'interrupt', 'queue', 'steer', 'model-switching', 'thinking-control', 'extension-ui', 'command-discovery', 'recovery', 'resume', 'fork']) {
  requireText(liveProtocol, new RegExp(`\\| '${capability}'`), `Live protocol capability 缺少：${capability}`)
}
requireText(liveProtocol, /export interface LiveCommandDto[\s\S]{0,220}value:\s*string[\s\S]{0,220}group\?:\s*string/, 'LiveCommandDto 必须保持 Runtime-owned value 与可选 group')
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
requireText(liveTask, /setInputHistory\(previous => appendLiveInputHistory\(previous, optimisticText\)\)/, '成功发送后必须追加输入历史')
requireText(liveTask, /composerRef\.current\?\.restoreMessage\(message\)/, '发送失败必须恢复原提交内容')
requireText(liveTask, /onDraftPresenceChange=\{setComposerHasContent\}/, 'LiveTaskPage 只能消费轻量内容存在性')
forbidText(liveTask, /onDraftChange=/, 'LiveTaskPage 不得接收每次按键的完整草稿')
requireText(liveTask, /onAttachmentPendingChange=\{setComposerAttachmentPending\}/, 'LiveTaskPage 必须感知附件上传 pending')
requireText(liveTask, /disabled=\{!canSubmit \|\| !composerHasContent\}/, '发送按钮必须受 capability/pending/content 联合约束')

/* Historical Review actions are also product/capability projections, never source-id checks. */
requireText(reviewPage, /projectReviewLiveInteraction\(detail, liveProducts\)/, 'Review 必须通过通用 Live Product 投影恢复/分叉能力')
requireText(reviewPage, /liveApi\.resume\(detailLiveInteraction\.liveId, detail\.id\)/, 'Review resume 必须走通用 liveId')
requireText(reviewPage, /liveApi\.fork\(detailLiveInteraction\.liveId, detail\.id\)/, 'Review fork 必须走通用 liveId')
forbidText(reviewPage, /sourceIds\.includes\(['"]pi['"]\)[\s\S]{0,500}(?:continueSession|forkContinue)/, 'Review 不得再通过 Pi sourceId 决定历史继续能力')
requireText(reviewLiveInteraction, /product\.productId === session\.productId/, 'Review Live 能力必须按 productId 匹配')
requireText(reviewLiveInteraction, /product\.capabilities\.includes\('resume'\)/, 'Review resume 必须来自 capability')
requireText(reviewLiveInteraction, /product\.capabilities\.includes\('fork'\)/, 'Review fork 必须来自 capability')

/* Keep the architecture anti-regression test itself alive. */
requireText(architectureTest, /统一 Product Surface 不直接依赖 Pi Live 兼容 Client 或页面/, '缺少 Product Surface 去 Pi 专属依赖回归测试')
requireText(architectureTest, /LiveTask 高级交互只消费通用 capability 与 control/, '缺少 LiveTask capability 架构回归测试')

/* Slash command discovery crosses generic HTTP/adapter boundaries only. */
requireText(liveHttp, /action === 'commands' && request\.method === 'GET'/, 'Live HTTP 缺少通用 commands GET')
requireText(liveHttp, /requireCapability\(adapter, 'command-discovery'\)/, 'Live commands HTTP 必须由 command-discovery capability 驱动')
requireText(piLiveAdapter, /'command-discovery'/, 'Pi Live Adapter 必须显式声明 command-discovery')
requireText(piLiveAdapter, /async commands\(runtimeSessionId: string\)/, 'Pi Live Adapter 必须把 Runtime 命令投影为通用 LiveCommand')
requireText(piLiveAdapter, /value: `\/\$\{command\.name\}`/, 'Pi Live Adapter 必须在 Adapter 边界生成可发送 Slash value')
forbidText(liveTask, /get_commands|BUILTIN_SLASH_COMMANDS/, 'Product Surface 不得依赖 Pi get_commands / Built-in 命令')

/* AgentLens-owned command menu copy must exist in both official locales. */
requireText(zhTaskLocale, /commandMenu:[\s\S]{0,100}aria:\s*'可用命令'/, '缺少 Slash 命令中文文案')
requireText(enTaskLocale, /commandMenu:[\s\S]{0,100}aria:\s*'Available commands'/, '缺少 Slash 命令英文文案')

if (failures.length) {
  console.error('Live Product 表现层契约检查失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('Live Product 表现层契约检查通过：通用路由、Live catalog、能力驱动 New Task/Live Task、通用运行列表、Review resume/fork 与 Pi 兼容边界均已锁定。')
