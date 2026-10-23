import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const taskCenter = readFileSync(new URL('./TaskCenterPage.tsx', import.meta.url), 'utf8')
const page = [
  readFileSync(new URL('./LiveTaskPage.tsx', import.meta.url), 'utf8'),
  readFileSync(new URL('./use-live-task-runtime.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./use-live-task-history.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./use-live-task-actions.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./live-task-state.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./live-task-queue.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./live-task-input.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./LiveTaskTimeline.tsx', import.meta.url), 'utf8'),
  readFileSync(new URL('./live-task-history-window.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./task-live-runtime.ts', import.meta.url), 'utf8')
].join('\n')
const liveTask = readFileSync(new URL('./LiveTaskPage.tsx', import.meta.url), 'utf8')
const liveActions = readFileSync(new URL('./use-live-task-actions.ts', import.meta.url), 'utf8')
const taskMessage = readFileSync(new URL('./TaskMessage.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../live-task.css', import.meta.url), 'utf8')
const composerCss = readFileSync(new URL('../task-session-composer.css', import.meta.url), 'utf8')
const taskComposer = readFileSync(new URL('../components/TaskSessionComposer.tsx', import.meta.url), 'utf8')
const reviewTask = readFileSync(new URL('./ReviewPage.tsx', import.meta.url), 'utf8')
const sessionCss = readFileSync(new URL('../task-session-view.css', import.meta.url), 'utf8')
const tokens = readFileSync(new URL('../tokens.css', import.meta.url), 'utf8')
const globalStyles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
const pill = readFileSync(new URL('../components/ComposerPillSelect.tsx', import.meta.url), 'utf8')
const selectMenu = readFileSync(new URL('../components/SelectMenu.tsx', import.meta.url), 'utf8')
const selectCss = readFileSync(new URL('../components/select-menu.css', import.meta.url), 'utf8')
const composer = readFileSync(new URL('../components/LiveMarkdownComposer.tsx', import.meta.url), 'utf8')
const imageNode = readFileSync(new URL('../components/LiveImageNode.tsx', import.meta.url), 'utf8')
const attachmentClient = readFileSync(new URL('../client/live-attachments.ts', import.meta.url), 'utf8')

test('连接状态操作统一由 TaskSessionComposer 渲染，Live 仅提供重连/同步回调', () => {
  assert.match(taskComposer, /onSyncSession\?\(\): void/)
  assert.match(taskComposer, /onReconnectSession\?\(\): void/)
  assert.match(taskComposer, /<Popover open=\{connectionMenuOpen && canManageConnection\}/)
  assert.match(taskComposer, /aria-haspopup="menu"/)
  assert.match(liveTask, /onSyncSession=\{streamSupported/)
  assert.match(liveTask, /onReconnectSession=\{streamSupported/)
  assert.match(page, /manualSyncRef\.current = async \(\) =>/)
  assert.match(page, /await recover\(runtimeStateRef\.current\?\.isStreaming/)
  assert.match(page, /reconnectEpoch/)
  assert.match(composerCss, /\.task-composer-menu-popover \{/)
  assert.doesNotMatch(reviewTask, /onSyncSession=|onReconnectSession=/)
})

test('通用 Live 产品层不再依赖 legacy PiLivePage / piLiveApi', () => {
  assert.doesNotMatch(app, /import\(['"]\.\/features\/PiLivePage['"]\)/)
  assert.doesNotMatch(taskCenter, /PiLivePage|piLiveApi/)
  assert.doesNotMatch(page, /\bPiLivePage\b|\bpiLiveApi\b|PiLiveTaskRound|pi-live-current|pi-live-task-projection/)
})

test('模型和推理选择只在唯一 TaskSessionComposer 中实现，SelectMenu 仍为唯一控件', () => {
  for (const source of [liveTask, reviewTask]) {
    assert.match(source, /<TaskSessionComposer/)
    assert.doesNotMatch(source, /<LiveMarkdownComposer(?:\s|\/>|>)|<ComposerPillSelect|className="task-composer-editor"/)
  }
  assert.match(taskComposer, /modelVisible && <ComposerPillSelect/)
  assert.match(taskComposer, /thinkingVisible && <ComposerPillSelect/)
  assert.match(taskComposer, /value=\{modelControl\?\.value \?\? ''\}/)
  assert.match(taskComposer, /value=\{thinking\?\.value \?\? ''\}/)
  assert.match(taskComposer, /control="model"/)
  assert.match(taskComposer, /control="thinking"/)
  assert.match(taskComposer, /disabled=\{controlsBusy \|\| !controlsReady \|\| !modelControl\}/)
  assert.match(taskComposer, /disabled=\{controlsBusy \|\| !controlsReady \|\| !thinking/)
  assert.match(pill, /task-composer-control--\$\{control\}/)
  assert.match(pill, /<SelectMenu/)
  assert.doesNotMatch(pill, /variant=|menuWidth=/)
  assert.match(composerCss, /\.task-composer-control--model \{ flex: 1 1 264px; \}/)
  assert.match(composerCss, /\.task-composer-control--thinking \{ flex: 0 0 140px; \}/)
  assert.match(composerCss, /\.task-composer-control--thinking \{ flex: 0 0 116px; \}/)
  assert.match(selectCss, /\.select-menu-trigger \{[^}]*height:\s*32px;/s)
  assert.match(selectMenu, /createPortal\(/)
})

test('Review 和 Live 共享唯一输入区、状态栏、模式控制及发送操作', () => {
  for (const source of [liveTask, reviewTask]) {
    assert.match(source, /className="task-session-composer-slot"/)
    assert.match(source, /<TaskSessionComposer/)
    assert.match(source, /onExpandedChange=\{setComposerExpanded\}/)
    assert.match(source, /hasContent=\{composerHasContent\}/)
    assert.doesNotMatch(source, /<textarea|<LiveMarkdownComposer(?:\s|\/>|>)|<ComposerPillSelect/)
    assert.doesNotMatch(source, /pi-live-compose-wrap|pi-live-composer|pi-live-editor/)
  }
  for (const token of ['task-composer-editor-toolbar','task-composer-editor-action','task-composer-bar','task-composer-settings','task-composer-mode','task-composer-send','task-composer-idle-dot']) {
    assert.ok(taskComposer.includes(token), token)
    assert.ok(composerCss.includes('.' + token), token)
  }
  assert.match(taskComposer, /<LiveMarkdownComposer \{\.\.\.editorProps\}/)
  assert.match(taskComposer, /showStreamingModes &&/)
  assert.match(reviewTask, /modesDisabled/)
  assert.match(reviewTask, /pendingModelControl=\{detailLiveInteraction\?\.canModelControl\}/)
  assert.match(reviewTask, /pendingThinkingControl=\{detailLiveInteraction\?\.canThinkingControl\}/)
  assert.doesNotMatch(css, /\.task-composer(?:\b|[.#:{])/)
  assert.doesNotMatch(readFileSync(new URL('../review.css', import.meta.url), 'utf8'), /\.task-composer(?:\b|[.#:{])/)
})

test('Live 编辑能力仍通过共享 LiveMarkdownComposer 接入', () => {
  assert.match(taskComposer, /<LiveMarkdownComposer \{\.\.\.editorProps\}/)
  assert.match(liveTask, /draft=\{draft\}/)
  assert.match(liveTask, /draftKey=\{composerDraftKey \|\| undefined\}/)
  assert.match(liveTask, /inputHistory=\{inputHistory\}/)
  assert.match(liveTask, /commands=\{commands\}/)
  assert.match(liveTask, /workspaceReferenceSearch=/)
  assert.match(liveTask, /onDraftPresenceChange=\{setComposerHasContent\}/)
  assert.match(liveTask, /onAttachmentPendingChange=\{setComposerAttachmentPending\}/)
  assert.match(liveTask, /mode === ['"]followUp['"] \? ['"]follow-up['"] : undefined/)
  assert.doesNotMatch(taskComposer, /<textarea|onDraftChange=/)
})

test('发送后恢复跟随使用的 setNewRecords 必须来自 LiveTaskState，防止页面 ReferenceError', () => {
  const state = readFileSync(new URL('./live-task-state.ts', import.meta.url), 'utf8')
  assert.match(state, /const \[newRecords, setNewRecords\] = useState\(false\)/)
  assert.match(state, /newRecords,\s*setNewRecords,/)
  const sessionBindings = liveTask.slice(liveTask.indexOf('const session = useLiveTaskState()'))
    .split('} = session')[0]
  assert.match(sessionBindings, /newRecords,\s*setNewRecords,/)
  assert.match(liveTask, /followControllerRef\.current\.restore\(\)[\s\S]*?setNewRecords\(false\)/)
})

test('Live 首次定位必须从共享状态解构 historyPage，避免打开页面时 ReferenceError', () => {
  const hook = readFileSync(new URL('./use-live-task-runtime.ts', import.meta.url), 'utf8')
  const bindingStart = hook.indexOf('  const {')
  const bindingEnd = hook.indexOf('  } = session', bindingStart)
  assert.ok(bindingStart >= 0 && bindingEnd > bindingStart, 'LiveTaskState bindings exist')
  const bindings = hook.slice(bindingStart, bindingEnd)
  assert.match(bindings, /\bhistoryPage\s*,/)
  assert.match(hook, /!historyPage/)
  assert.match(hook, /\[current\?\.runtimeSessionId, historyPage,/)
})

test('Live Enter and send share slash routing, acknowledgement, and reader intent', () => {
  assert.match(liveActions, /onSendAccepted\?\.\(\)/)
  assert.match(liveActions, /onSendDelivered\?\.\(\)/)
  assert.match(liveActions, /setSendFeedback\('sending'\)/)
  assert.match(liveActions, /setSendFeedback\('failed'\)/)
  assert.match(liveActions, /await liveApi\.send\(current\.liveId, current\.runtimeSessionId, message, behavior\)/)
  assert.match(liveTask, /submitLiveMessage\(message, mode === 'followUp'/)
  assert.match(liveTask, /if \(message\) submitLiveMessage\(message\)/)
  assert.match(liveTask, /resolveLiveSlash\(message, commands\)/)
  assert.match(liveTask, /scrollReaderToLastUserTurn\(reader\)/)
  assert.match(liveTask, /followControllerRef\.current\.restore\(\)/)
  assert.match(liveTask, /onSendAccepted, onSendDelivered \}\)/)
  assert.match(liveTask, /onWheel=\{event => markReaderUserIntent/)
  assert.match(taskComposer, /live\.sendFeedback/)
})

test('Slash and @ suggestions share a single keyboard interaction with composition and modifier guards', () => {
  assert.match(composer, /function useComposerSuggestionKeyboard\(/)
  assert.equal((composer.match(/useComposerSuggestionKeyboard\(/g) ?? []).length, 3)
  assert.match(composer, /!event\.isComposing && event\.keyCode !== 229/)
  assert.match(composer, /!event\.shiftKey && !event\.altKey && !event\.ctrlKey && !event\.metaKey/)
  assert.match(composer, /COMMAND_PRIORITY_CRITICAL/)
})

test('共享 Composer 保留 Markdown、大文本、图片、Shift+Enter 与 Alt+Enter 语义', () => {
  assert.match(composer, /<ListPlugin\/>/)
  assert.match(composer, /MarkdownShortcutPlugin transformers=\{TRANSFORMERS\}/)
  assert.match(composer, /function LargePastePlugin/)
  assert.match(composer, /isLargeLivePaste\(text\)/)
  assert.match(composer, /\$createLiveLargeTextNode\(text\)/)
  assert.match(composer, /function ImagePastePlugin/)
  assert.match(composer, /file\.type\.startsWith\('image\/'\)/)
  assert.match(composer, /uploadLiveAttachment\(item\.file, item\.attachmentId\)/)
  assert.match(composer, /INSERT_PARAGRAPH_COMMAND/)
  assert.match(composer, /if \(event\.shiftKey\)/)
  assert.match(composer, /event\.altKey \? 'followUp' : 'default'/)
  assert.match(composer, /event\.isComposing/)
  assert.match(imageNode, /liveAttachmentPreviewUrl\(attachmentId\)/)
  assert.match(attachmentClient, /method: 'POST'/)
  assert.match(attachmentClient, /method: 'DELETE'/)
})

test('流式消息继续复用 TaskMessage，不恢复第二套响应气泡', () => {
  assert.match(taskMessage, /data-streaming=\{streaming \? 'true' : undefined\}/)
  assert.match(taskMessage, /aria-busy=\{streaming \|\| awaitingFirstContent \|\| undefined\}/)
  assert.doesNotMatch(page, /pi-live-stream-response|pi-live-stream-text|PiLiveRunningTaskRound/)
  assert.doesNotMatch(css, /\.pi-live-stream-response|\.pi-live-stream-text|\.pi-live-caret/)
  assert.match(sessionCss, /\.task-session-view \.task-session-reader \{[\s\S]*?scrollbar-gutter:\s*stable;/)
  assert.match(sessionCss, /\.task-session-view \.task-session-reader \{[\s\S]*?overflow-anchor:\s*none;/)
  assert.match(globalStyles, /\.markdown-streaming-tail\s*\{[\s\S]*?white-space:\s*pre-wrap;/)
})

test('Live Composer 窄窗收起连接文字但保留可操作入口', () => {
  assert.match(composerCss, /@media \(max-width: 1199\.98px\)/)
  assert.match(composerCss, /\.task-composer-runtime-label \{ display: none; \}/)
  assert.match(composerCss, /\.task-composer-connection-anchor:has/)
  assert.match(taskComposer, /sessionActions\.length > 0/)
  assert.match(liveTask, /sessionActions=\{composerSessionActions\}/)
  assert.match(liveTask, /action\.placement === 'composer'/)
})

test('Review/Live 头部、阅读区和 Live Composer 共用 820px 宽度上限', () => {
  // A single token owns the desktop reading width; the composer aliases it.
  assert.match(tokens, /--al-content-task-reading:\s*820px;/)
  assert.match(tokens, /--al-content-task-composer:\s*var\(--al-content-task-reading\);/)
  assert.match(sessionCss, /\.task-session-view \.task-session-document \{[^}]*max-width:\s*var\(--al-content-task-reading\);/s)
  assert.match(sessionCss, /\.task-session-view \.task-header \{[^}]*max-width:\s*var\(--al-content-task-reading\);/s)
  assert.match(composerCss, /\.task-composer \{[^}]*max-width:\s*var\(--al-content-task-composer\);/s)
  assert.match(css, /\.live-task-float-stack \{[^}]*width:\s*min\(var\(--al-content-task-composer\),/s)
  assert.match(sessionCss, /@media \(max-width: 767\.98px\)/)
  assert.match(composerCss, /@media \(max-width: 767\.98px\)/)
})

test('排队消息进入唯一 Composer 顶部，默认轻量收起且由 Runtime 页面提供内容', () => {
  assert.match(taskComposer, /queueContent\?: ReactNode/)
  assert.match(taskComposer, /task-composer-queue-slot/)
  assert.match(liveTask, /queueContent=\{queueContent\}/)
  assert.match(liveTask, /aria-expanded=\{queueExpanded\}/)
  assert.match(liveTask, /queueItems\.map\(item =>/)
  assert.match(css, /\.live-task-queue-list \{[^}]*max-height:\s*156px;/s)
  assert.doesNotMatch(css, /\.live-task-queue-item \{[^}]*box-shadow:/s)
  assert.doesNotMatch(liveTask, /live-task-startup-queue/)
})

test('Live 单条队列操作经原生变更接口，不再在浏览器清空并重发', () => {
  assert.match(liveActions, /await liveApi\.mutateQueue\(/)
  assert.match(liveActions, /expected: \{ steering: \[\.\.\.queue\.steering\], followUp: \[\.\.\.queue\.followUp\] \}/)
  assert.match(liveActions, /const editQueued = useCallback/)
  assert.match(liveActions, /const clearQueued = useCallback/)
  assert.doesNotMatch(liveActions, /for \(const message of steering\)/)
  assert.doesNotMatch(liveActions, /for \(const message of followUp\)/)
})

test('Live 等待响应与停止入口只有共享 Composer 渲染', () => {
  assert.match(taskComposer, /responseActivity && <div className="task-composer-response-hint"/)
  assert.match(taskComposer, /interruptAvailable && <IconButton/)
  assert.match(taskComposer, /className="task-composer-stop"/)
  assert.match(taskComposer, /hasContent && editorProps.canSubmit/)
  assert.match(liveTask, /responseActivity=\{responseActivity\}/)
  assert.match(liveTask, /interruptAvailable=\{interruptAvailable\}/)
  assert.match(liveTask, /document.addEventListener\('keydown', onPageEscape\)/)
  assert.match(liveTask, /event.defaultPrevented \|\| event.isComposing/)
  assert.match(composerCss, /\.task-composer-response-hint \{/)
  assert.doesNotMatch(reviewTask, /interruptAvailable=|responseActivity=/)
})

test('Live-only 指标常驻输入区下方，悬浮与点击共用 Popover，Review 不伪造', () => {
  assert.match(taskComposer, /className="task-composer-shell"/)
  assert.match(taskComposer, /runtimeMetrics && <div className="task-composer-runtime-metrics"/)
  assert.match(taskComposer, /onMouseEnter=\{\(\) => showMetric\('context'\)\}/)
  assert.match(taskComposer, /onMouseEnter=\{\(\) => showMetric\('cache'\)\}/)
  assert.match(taskComposer, /<Popover open=\{metricOpen === 'context'\}/)
  assert.match(taskComposer, /<Popover open=\{metricOpen === 'cache'\}/)
  assert.match(liveTask, /runtimeMetrics=\{\{ contextUsage: state\?\.contextUsage, cacheMetrics: state\?\.cacheMetrics \}\}/)
  assert.doesNotMatch(reviewTask, /runtimeMetrics=/)
  assert.match(composerCss, /\.task-composer-runtime-metrics \{/)
  assert.doesNotMatch(taskComposer, /DS Cache 0%|0% \/ 1M/)
})

test('兼容指标不冒充运行时兼容状态，只有可信来源才能显示警告', () => {
  assert.match(taskComposer, /\{t\('live.metrics.compat'\)\} \{compatibilityLabel\}/)
  assert.match(taskComposer, /onMouseEnter=\{\(\) => showMetric\('compat'\)\}/)
  assert.match(taskComposer, /<Popover open=\{metricOpen === 'compat'\}/)
  assert.doesNotMatch(taskComposer, /runtimeMode === 'compatibility'/)
})

test('缓存与兼容显示 Pi 扩展真实来源，不再硬编码缺失值', () => {
  assert.match(taskComposer, /cacheLabel = cacheMetrics \?/)
  assert.match(taskComposer, /tokenHitRate\.toFixed\(1\)/)
  assert.match(taskComposer, /\{t\('live.metrics.cache'\)\} \{cacheLabel\}/)
  assert.match(taskComposer, /compatibility === 'warning'/)
  assert.match(taskComposer, /cacheMetrics\.hitRequests/)
  assert.match(taskComposer, /cacheMetrics\.cachedInput/)
  assert.doesNotMatch(taskComposer, /runtimeMode === 'compatibility'/)
})
