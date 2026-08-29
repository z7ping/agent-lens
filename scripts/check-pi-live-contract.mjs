import { readFile } from 'node:fs/promises'

const [app, page, history, client, css, http, runtime, coreObservation, timelineProtocol] = await Promise.all([
  readFile(new URL('../packages/web/src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/PiLivePage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/pi-live-history.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/client/pi-live.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/pi-live.css', import.meta.url), 'utf8'),
  readFile(new URL('../packages/surface-http/src/pi-live.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/service.ts', import.meta.url), 'utf8'),
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
requireText(app, /path="\/review\/live"/, '缺少 /review/live 路由')
requireText(app, /path="\/review\/live\/:runtimeSessionId"/, '缺少 Pi Live runtime 路由')
requireText(app, /onPiLive[\s\S]*!onPiLive/, 'Pi Live 必须从普通 Review overlay/turn rail 语义中分离')
requireText(app, /onLocalReview\s*&&\s*<NavLink[^>]*to="\/review\/live"[^>]*>Pi 实时<\/NavLink>/, '任务复盘域必须提供 Pi 实时可发现入口')

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

requireText(history, /entry\.type === 'model_change'/, 'Pi Live 历史投影缺少持久化 model_change')
requireText(history, /entry\.type === 'thinking_level_change'/, 'Pi Live 历史投影缺少持久化 thinking_level_change')
requireText(history, /message\.role !== 'tool' && message\.role !== 'toolResult'/, 'Pi Live 历史投影缺少 Tool Result 事实')
requireText(coreObservation, /'thinking\.level\.changed'/, 'Core ObservationKind 缺少 thinking.level.changed')
requireText(timelineProtocol, /'thinking\.level\.changed'/, 'Timeline Protocol 缺少 thinking.level.changed')

requireText(client, /HIDDEN_FLUSH_MS = 250/, '后台页面必须降低 Streaming UI 提交频率')
requireText(client, /requestAnimationFrame/, '前台 Streaming 必须按动画帧批量提交')
requireText(client, /coalescedEvents/, 'Streaming Scheduler 缺少事件合并诊断')
requireText(client, /tool_execution_update[\s\S]*latest value replaces earlier progress/, 'Tool Progress 必须使用 Pi 累计结果进行替换合并')
requireText(client, /source\.close\(\)/, '关闭 Pi Live View 必须只关闭 EventSource')
if (/terminate\([^)]*\)[\s\S]{0,120}source\.close/.test(client)) failures.push('View dispose 不得隐式 terminate Pi Runtime')

requireText(http, /request\.once\('close', cleanup\)/, 'Pi Live SSE 断开必须释放订阅')
requireText(http, /service\.terminate\(runtimeSessionId\)/, 'Pi Runtime 必须只有显式 DELETE 终止路径')
requireText(runtime, /clearQueue\(runtimeSessionId\)/, 'Abort 必须支持队列取回')
requireText(runtime, /type: 'extension_ui_response'[\s\S]*id: requestId/, 'Extension UI 必须原样回传 Pi request id')

if (/font-size:\s*(?:[0-9]|1[01])px/.test(css)) failures.push('Pi Live 可见文字不得小于 12px')
if (/backdrop-filter|filter:\s*blur\(/.test(css)) failures.push('Pi Live 不得使用模糊/毛玻璃')
if (/max-width:\s*575|max-width:\s*576|min-width:\s*576/.test(css)) failures.push('Pi Live 不得新增 576px 响应式断点')
for (const expected of ['1199.98px', '991.98px', '767.98px']) {
  if (!css.includes(expected)) failures.push(`Pi Live CSS 缺少现有响应式基线 ${expected}`)
}

if (failures.length) {
  console.error('Pi Live Task Surface 契约检查失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('Pi Live Task Surface 契约检查通过：五页导航、事件层级、历史事实、IME、Stop/Terminate、滚动跟随、Extension UI、背压与性能诊断已锁定。')
