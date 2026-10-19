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
const css = readFileSync(new URL('../pi-live.css', import.meta.url), 'utf8')
const sessionCss = readFileSync(new URL('../task-session-view.css', import.meta.url), 'utf8')
const tokens = readFileSync(new URL('../tokens.css', import.meta.url), 'utf8')
const globalStyles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
const pill = readFileSync(new URL('../components/ComposerPillSelect.tsx', import.meta.url), 'utf8')
const selectMenu = readFileSync(new URL('../components/SelectMenu.tsx', import.meta.url), 'utf8')
const selectCss = readFileSync(new URL('../components/select-menu.css', import.meta.url), 'utf8')
const composer = readFileSync(new URL('../components/LiveMarkdownComposer.tsx', import.meta.url), 'utf8')
const imageNode = readFileSync(new URL('../components/LiveImageNode.tsx', import.meta.url), 'utf8')
const attachmentClient = readFileSync(new URL('../client/live-attachments.ts', import.meta.url), 'utf8')

test('通用 Live 产品层不再依赖 legacy PiLivePage / piLiveApi', () => {
  assert.doesNotMatch(app, /import\(['"]\.\/features\/PiLivePage['"]\)/)
  assert.doesNotMatch(taskCenter, /PiLivePage|piLiveApi/)
  assert.doesNotMatch(page, /\bPiLivePage\b|\bpiLiveApi\b|PiLiveTaskRound|pi-live-current|pi-live-task-projection/)
})

test('通用 Live 模型和推理选择只使用共享 SelectMenu 契约', () => {
  assert.match(page, /modelControl && <ComposerPillSelect/)
  assert.match(page, /thinking && <ComposerPillSelect/)
  assert.match(page, /value=\{modelControl\.value \?\? ''\}/)
  assert.match(page, /value=\{thinking\.value\}/)
  assert.match(page, /modelControl && <ComposerPillSelect\s+control="model"/)
  assert.match(page, /thinking && <ComposerPillSelect\s+control="thinking"/)
  assert.match(pill, /pi-live-compose-control--\$\{control\}/)
  assert.match(pill, /<SelectMenu/)
  assert.match(pill, /value=\{value\}/)
  assert.match(pill, /onChange=\{onChange\}/)
  assert.doesNotMatch(pill, /variant=|menuWidth=/)
  assert.match(css, /\.pi-live-compose-control--model \{ flex: 1 1 264px; \}/)
  assert.match(css, /\.pi-live-compose-control--thinking \{ flex: 0 0 140px; \}/)
  assert.match(css, /\.pi-live-compose-control--thinking \{ flex: 0 0 116px; \}/)
  assert.match(selectCss, /\.select-menu-trigger \{[^}]*height:\s*32px;/s)
  assert.match(selectMenu, /createPortal\(/)
  assert.match(selectCss, /\.select-menu-popover\s*\{[\s\S]*?position:\s*fixed;/)
})

test('通用 Live Composer 只通过共享 LiveMarkdownComposer 承载编辑状态', () => {
  assert.match(page, /<LiveMarkdownComposer/)
  assert.match(page, /draft=\{draft\}/)
  assert.match(page, /draftKey=\{composerDraftKey \|\| undefined\}/)
  assert.match(page, /inputHistory=\{inputHistory\}/)
  assert.match(page, /commands=\{commands\}/)
  assert.match(page, /workspaceReferenceSearch=/)
  assert.match(page, /onDraftPresenceChange=\{setComposerHasContent\}/)
  assert.match(page, /onAttachmentPendingChange=\{setComposerAttachmentPending\}/)
  assert.match(page, /mode === ['"]followUp['"] \? ['"]follow-up['"] : undefined/)
  assert.doesNotMatch(page, /<textarea[^>]*className="pi-live-input"/)
  assert.doesNotMatch(page, /onDraftChange=/)
})

test('Live 输入框回车与发送按钮在发送接受后跳最新，用户主动上翻仍能退出跟随', () => {
  assert.match(liveActions, /onSendAccepted\?\.\(\)/)
  assert.match(liveActions, /onSendDelivered\?\.\(\)/)
  assert.match(liveActions, /if \(unsupported\) \{[\s\S]*?return[\s\S]*?onSendAccepted\?\.\(\)/)
  assert.match(liveActions, /await liveApi\.send\(current\.liveId, current\.runtimeSessionId, message, behavior\)[\s\S]*?onSendDelivered\?\.\(\)/)
  assert.match(liveTask, /followControllerRef\.current\.restore\(\)/)
  assert.match(liveTask, /onSendAccepted, onSendDelivered \}\)/)
  assert.match(liveTask, /onSubmit=\{\(message, mode\) => \{ void send\(message, mode === 'followUp' \? 'follow-up' : undefined\) \}\}/)
  assert.match(liveTask, /if \(message\) void send\(message\)/)
  assert.match(liveTask, /onSendDelivered = useCallback\(\(\) => \{[\s\S]*?followControllerRef\.current\.isFollowing\) void jumpLatest\(\)/)
  assert.match(liveTask, /onWheel=\{event => markReaderUserIntent/)
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

test('Live Composer 窄窗继续收回状态文本空间', () => {
  assert.match(css, /@media \(max-width: 1199\.98px\) \{[\s\S]*?\.pi-live-compose-runtime \{ display: none; \}/)
})

test('Review/Live 头部、阅读区和 Live Composer 共用 820px 宽度上限', () => {
  // A single token owns the desktop reading width; the composer aliases it.
  assert.match(tokens, /--al-content-task-reading:\s*820px;/)
  assert.match(tokens, /--al-content-task-composer:\s*var\(--al-content-task-reading\);/)
  assert.match(sessionCss, /\.task-session-view \.task-session-document \{[^}]*max-width:\s*var\(--al-content-task-reading\);/s)
  assert.match(sessionCss, /\.task-session-view \.task-header \{[^}]*max-width:\s*var\(--al-content-task-reading\);/s)
  assert.match(css, /\.pi-live-composer \{[^}]*max-width:\s*var\(--al-content-task-composer\);/s)
  assert.match(css, /\.pi-live-float-stack \{[^}]*width:\s*min\(var\(--al-content-task-composer\),/s)
  assert.match(sessionCss, /@media \(max-width: 767\.98px\)/)
  assert.match(css, /@media \(max-width: 767\.98px\)/)
})
