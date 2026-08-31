import { readFile } from 'node:fs/promises'

const [app, taskCenter, taskSurface, taskCenterCss, reviewPage, page, hubPage, history, client, css, http, runtime, sdkLoader, coreObservation, timelineProtocol] = await Promise.all([
  readFile(new URL('../packages/web/src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/TaskCenterPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/TaskSurface.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/task-center.css', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/ReviewPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/PiLivePage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/HubReviewPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/pi-live-history.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/client/pi-live.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/pi-live.css', import.meta.url), 'utf8'),
  readFile(new URL('../packages/surface-http/src/pi-live.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/service.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/sdk-loader.ts', import.meta.url), 'utf8'),
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
requireText(taskCenter, /deriveTaskProjectOptions/, '新建任务必须从已观测项目上下文推导工作目录')
requireText(taskCenter, /cwd:\s*selected\.cwd/, 'Pi Runtime cwd 必须来自已选择的真实项目上下文')
if (/setCwd|工作目录\s*<input|placeholder=.*workspace/.test(taskCenter)) failures.push('任务中心新建主流程不得要求用户手输 cwd')
if (/\.task-center-main \.pi-live-page > \.pi-live-sessions\s*\{\s*display:\s*none;/m.test(taskCenterCss)) failures.push('任务中心不得继续依赖 CSS 隐藏 Pi Live 第二套侧栏')
if (/\.task-center-main \.review-layout > \.session-panel\s*\{\s*display:\s*none;/m.test(taskCenterCss)) failures.push('任务中心不得继续依赖 CSS 隐藏 Review 第二套侧栏')
if (/\.task-center-main \.hub-review-toolbar\s*\{\s*display:\s*none;/m.test(taskCenterCss)) failures.push('任务中心不得继续依赖 CSS 隐藏 Hub 工具栏')

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
requireText(runtime, /extensionUi\.respond\(requestId, response\)/, 'Extension UI 必须原样关联 Pi SDK request id')
requireText(sdkLoader, /@earendil-works\/pi-coding-agent/, 'Pi Live 必须从官方 npm 包定位 SDK')
requireText(sdkLoader, /createAgentSession/, 'Pi Live SDK Loader 必须校验官方 createAgentSession API')
requireText(sdkLoader, /await import\(pathToFileURL\(discovery\.sdkEntry\)\.href\)/, 'Pi Live 必须进程内加载官方 SDK，不得重新 spawn RPC')
if (/PiRpcClient|--mode['"\s,]+rpc|child_process/.test(`${runtime}\n${sdkLoader}`)) failures.push('Pi Live Runtime 不得重新引入自维护 RPC 子进程协议')

if (/font-size:\s*(?:[0-9]|1[01])px/.test(css) || /font-size:\s*(?:[0-9]|1[01])px/.test(taskCenterCss)) failures.push('Pi Live / 任务中心可见文字不得小于 12px')
if (/backdrop-filter|filter:\s*blur\(/.test(css) || /backdrop-filter|filter:\s*blur\(/.test(taskCenterCss)) failures.push('Pi Live / 任务中心不得使用模糊/毛玻璃')
if (/max-width:\s*575|max-width:\s*576|min-width:\s*576/.test(css) || /max-width:\s*575|max-width:\s*576|min-width:\s*576/.test(taskCenterCss)) failures.push('Pi Live / 任务中心不得新增 576px 响应式断点')
for (const expected of ['1199.98px', '991.98px', '767.98px']) {
  if (!css.includes(expected)) failures.push(`Pi Live CSS 缺少现有响应式基线 ${expected}`)
  if (!taskCenterCss.includes(expected)) failures.push(`任务中心 CSS 缺少现有响应式基线 ${expected}`)
}

if (failures.length) {
  console.error('Pi Live / 任务中心契约检查失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('Pi Live / 任务中心契约检查通过：统一 TaskSurface、嵌入态详情、官方 Pi SDK Runtime、活跃任务列举、项目上下文启动、事件层级、历史事实、IME、Stop/Terminate、滚动跟随、Extension UI、背压与性能诊断已锁定。')