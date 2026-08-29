import { readFile } from 'node:fs/promises'

const [app, page, client, css, http, runtime] = await Promise.all([
  readFile(new URL('../packages/web/src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/features/PiLivePage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/client/pi-live.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/pi-live.css', import.meta.url), 'utf8'),
  readFile(new URL('../packages/surface-http/src/pi-live.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/service.ts', import.meta.url), 'utf8'),
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

requireText(page, /onCompositionStart/, 'Pi Live 输入框缺少 compositionstart 保护')
requireText(page, /nativeEvent\.isComposing/, 'Pi Live 输入框缺少 isComposing 保护')
requireText(page, /keyCode === 229/, 'Pi Live 输入框缺少 IME keyCode 229 兼容')
requireText(page, /piLiveApi\.abort\(runtimeId, true\)/, '停止任务必须先取回 Pi 队列再 Abort')
requireText(page, /piLiveApi\.terminate\(runtimeId\)/, '结束 Runtime 必须是独立显式操作')
requireText(page, /followingRef/, 'Pi Live 缺少用户滚动跟随状态')
requireText(page, /setNewRecords\(true\)/, '历史阅读时缺少“有新记录”提示')
requireText(page, /extensionResponse/, 'Pi Live 缺少 Extension UI 回应链')
requireText(page, /PiLiveTransportDiagnostics/, 'Pi Live 页面缺少传输性能诊断')

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

console.log('Pi Live Task Surface 契约检查通过：五页导航、Live/Review 边界、IME、Stop/Terminate、滚动跟随、Extension UI、背压与性能诊断已锁定。')
