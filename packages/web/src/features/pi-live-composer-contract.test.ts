import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('./PiLivePage.tsx', import.meta.url), 'utf8')
const taskRound = readFileSync(new URL('./PiLiveTaskRound.tsx', import.meta.url), 'utf8')
const taskMessage = readFileSync(new URL('./TaskMessage.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../pi-live.css', import.meta.url), 'utf8')
const pill = readFileSync(new URL('../components/ComposerPillSelect.tsx', import.meta.url), 'utf8')
const selectMenu = readFileSync(new URL('../components/SelectMenu.tsx', import.meta.url), 'utf8')
const selectCss = readFileSync(new URL('../components/select-menu.css', import.meta.url), 'utf8')
const composer = readFileSync(new URL('../components/PiMarkdownComposer.tsx', import.meta.url), 'utf8')

test('Pi Live model and thinking controls use custom pill menus instead of native selects', () => {
  assert.match(page, /<ComposerPillSelect[\s\S]*?ariaLabel="Pi 模型"/)
  assert.match(page, /<ComposerPillSelect[\s\S]*?ariaLabel="Pi 推理强度"/)
  assert.match(page, /title=\{state\?\.model \? `Pi 模型 · \$\{modelLabel\(state\)\}` : 'Pi 模型'\}/)
  assert.match(page, /title=\{`Pi 推理强度 · \$\{state\?\.thinkingLevel \|\| '未设置'\}`\}/)
  assert.match(pill, /<SelectMenu[\s\S]*?variant="pill"/)
  assert.match(selectMenu, /createPortal\(/)
  assert.match(selectCss, /\.select-menu-popover\s*\{[\s\S]*?position:\s*fixed;/)
})

test('Pi Live composer uses Lexical Markdown shortcuts and keeps Markdown as the runtime value', () => {
  assert.match(page, /<PiMarkdownComposer/)
  assert.match(page, /ariaLabel="Pi Markdown 富文本输入"/)
  assert.doesNotMatch(page, /composerView|ReactMarkdown|<textarea[^>]*className="pi-live-input"/)
  assert.match(composer, /MarkdownShortcutPlugin transformers=\{TRANSFORMERS\}/)
  assert.match(composer, /\$convertToMarkdownString\(TRANSFORMERS/)
  assert.match(composer, /\$convertFromMarkdownString\(value, TRANSFORMERS/)
  assert.match(composer, /KEY_ENTER_COMMAND/)
  assert.match(composer, /event\.isComposing/)
  assert.match(composer, /event\.altKey \? 'followUp' : 'default'/)
})

test('Pi Live 初始化期间仍允许输入并可暂存首条任务', () => {
  assert.match(page, /const runtimeInitializing = !state \|\| state\.status === 'initializing'/)
  assert.match(page, /<PiStartupDisclosure/)
  assert.match(page, /piLiveApi\.retry\(runtimeId\)/)
  assert.match(page, /const canStageStartup = runtimeInitializing && !startupQueued/)
  assert.match(page, /disabled=\{runtimeTerminating\}/)
})

test('Pi Live composer keeps status labels and adjacent controls visually separated', () => {
  assert.match(css, /\.pi-live-compose-bar \{[^}]*gap:\s*12px;/)
  assert.match(css, /\.pi-live-compose-runtime \{[^}]*display:\s*inline-flex;[^}]*gap:\s*6px;/)
  assert.match(css, /\.pi-live-compose-settings \{[^}]*gap:\s*8px;/)
  assert.match(css, /\.pi-live-compose-mode \{[^}]*gap:\s*2px;/)
  assert.match(css, /\.pi-live-startup-queue > div \{[^}]*gap:\s*6px;/)
  assert.match(css, /\.pi-live-queue-item > div \{[^}]*gap:\s*6px;/)
  assert.match(css, /\.pi-live-review-link \{[^}]*display:\s*flex;[^}]*gap:\s*8px;/)
})

test('Pi Live streaming assistant reuses TaskMessage and has no parallel response bubble', () => {
  assert.match(taskRound, /<TaskMessage[\s\S]*?streaming=\{entry\.role === 'assistant' && entry\.state === 'running'\}/)
  assert.match(taskMessage, /data-streaming=\{streaming \? 'true' : undefined\}/)
  assert.match(taskMessage, /aria-busy=\{streaming \|\| undefined\}/)
  assert.doesNotMatch(taskRound, /pi-live-stream-response|pi-live-stream-text|PiLiveRunningTaskRound/)
  assert.doesNotMatch(css, /\.pi-live-stream-response|\.pi-live-stream-text|\.pi-live-caret/)
  assert.match(css, /\.pi-live-reader \{[\s\S]*?scrollbar-gutter:\s*stable;/)
  assert.match(css, /\.pi-live-reader \{[\s\S]*?overflow-anchor:\s*none;/)
})

test('Pi Live sends optimistically into one stable ordered current round before the first token', () => {
  assert.match(page, /const \[optimisticPrompt, setOptimisticPrompt\] = useState\(''\)/)
  assert.match(page, /const \[currentOrdinal, setCurrentOrdinal\] = useState<number \| null>\(null\)/)
  assert.match(page, /const \[currentItems, setCurrentItems\] = useState<PiLiveHistoryItem\[]>\(\[\]\)/)
  assert.match(page, /const beginOptimisticPrompt = useCallback\(\(text: string\) => \{[\s\S]*?setCurrentOrdinal\(null\)[\s\S]*?setCurrentItems\(\[\]\)[\s\S]*?activePromptRef\.current = text[\s\S]*?setOptimisticPrompt\(text\)/)
  assert.match(page, /if \(!optimisticPrompt && !state\?\.isStreaming && currentItems\.length === 0\) return undefined/)
  assert.match(page, /projectPiLiveRunningRound\(\{ items: currentItems, isStreaming: optimisticStreaming \}\)/)
  assert.match(page, /<PiLiveCurrentTaskRound[\s\S]*?items=\{currentItems\}/)
  assert.match(taskRound, /promptText && <TaskMessage role="user"/)
})

test('Pi Live SSE uses start/delta/end plus contentIndex to preserve interleaved source block order', () => {
  assert.match(page, /const assistantMessageEpochRef = useRef\(0\)/)
  assert.match(page, /type === 'message_start'[\s\S]*?assistantMessageEpochRef\.current \+= 1/)
  assert.match(page, /const contentIndex = typeof update\.contentIndex === 'number' \? update\.contentIndex : undefined/)
  assert.match(page, /const block = assistantPartialContent\(update, contentIndex\)/)
  assert.match(page, /messageEpoch: assistantMessageEpochRef\.current/)
  assert.match(page, /update\.type === 'text_start'[\s\S]*?startPiLiveContentBlock\(items, 'text'/)
  assert.match(page, /appendPiLiveDelta\(items, 'text', delta, deltaOptions\)/)
  assert.match(page, /update\.type === 'text_end'[\s\S]*?finishPiLiveContentBlock\(items, 'text'/)
  assert.match(page, /update\.type === 'thinking_start'[\s\S]*?startPiLiveContentBlock\(items, 'thinking'/)
  assert.match(page, /appendPiLiveDelta\(items, 'thinking', delta, deltaOptions\)/)
  assert.match(page, /update\.type === 'thinking_end'[\s\S]*?finishPiLiveContentBlock\(items, 'thinking'/)
  assert.match(page, /update\.type === 'toolcall_start' \|\| update\.type === 'toolcall_delta' \|\| update\.type === 'toolcall_end'/)
  assert.match(page, /const toolCall = Object\.keys\(completed\)\.length \? completed : block/)
  assert.match(page, /startPiLiveTool\(items,[\s\S]*?contentIndex/)
})

test('Pi Live auto-follow is coalesced to one animation frame and follows currentItems', () => {
  assert.match(page, /const followFrameRef = useRef<number \| null>\(null\)/)
  assert.match(page, /if \(!followingRef\.current \|\| followFrameRef\.current !== null\) return/)
  assert.match(page, /followFrameRef\.current = requestAnimationFrame\(\(\) => \{[\s\S]*?followFrameRef\.current = null[\s\S]*?reader\.scrollTop = target/)
  assert.doesNotMatch(page, /return \(\) => cancelAnimationFrame\(frame\)/)
  assert.match(page, /\[visibleHistoryRounds, currentItems, optimisticPrompt,[\s\S]*?restored, extension\?\.id\]/)
})

test('Pi Live settle reconciles Snapshot into the same current block list instead of replacing a second subtree', () => {
  assert.match(page, /const freshHistory = projectPiLiveHistory\(value\)[\s\S]*?const freshRounds = projectPiLiveTaskRounds\(freshHistory\)/)
  assert.match(page, /setCurrentItems\(current => reconcilePiLiveItems\(current, omitPiLivePromptMessages\(settledItems, resolvedPrompt\)\)\)/)
  assert.match(page, /historyRounds\.filter\(round => round\.model\.ordinal !== currentOrdinal\)/)
  assert.match(page, /return \{ \.\.\.settledProjection\.model, id: 'pi-live-current-round' \}/)
  assert.match(taskRound, /<HistoryEntries items=\{omitPiLivePromptMessages\(items, promptText\)\} showAllEvents=\{showAllEvents\}\/>/)
  assert.doesNotMatch(page, /settledCurrentItems|streamText|thinkingText|toolsRef|observedThinking/)
  assert.doesNotMatch(taskRound, /hasSettledItems|settledItems/)
})

test('Pi Live reconnect hydrates the streaming round from Snapshot into the same current items', () => {
  assert.match(page, /if \(value\.state\.isStreaming\) \{[\s\S]*?projectPiLiveTaskRounds\(projectPiLiveHistory\(value\)\)/)
  assert.match(page, /setCurrentOrdinal\(ordinal\)/)
  assert.match(page, /markPiLiveItemsRunning\(current\.length \? reconcilePiLiveItems\(current, persisted\) : persisted\)/)
  assert.match(page, /piLiveApi\.snapshot\(runtimeId, leafIdRef\.current\)\.then\(acceptSnapshot/)
})

test('Pi Live 生成中使用专用介入和继续通道并即时展示队列', () => {
  assert.match(page, /if \(selectedMode === 'steer'\) await piLiveApi\.steer\(runtimeId, text\)/)
  assert.match(page, /else await piLiveApi\.followUp\(runtimeId, text\)/)
  assert.match(page, /setPendingQueue\(current => \[\.\.\.current, pending\]\)/)
  assert.match(page, /正在加入 Pi 队列/)
  assert.match(page, /pendingMessageCount=\{visiblePendingCount\}/)
})

test('Pi Live 已入队消息可单项撤回并恢复其余队列', () => {
  assert.match(page, /const \[queueMutationPending, setQueueMutationPending\] = useState\(false\)/)
  assert.match(page, /const cleared = await piLiveApi\.clearQueue\(runtimeId\)/)
  assert.match(page, /if \(resolvedIndex >= 0\) target\.splice\(resolvedIndex, 1\)/)
  assert.match(page, /for \(const message of steering\) await piLiveApi\.steer\(runtimeId, message\)/)
  assert.match(page, /for \(const message of followUp\) await piLiveApi\.followUp\(runtimeId, message\)/)
  assert.match(page, /onClick=\{\(\) => void removeQueued\(item\.mode, Number\(item\.queueIndex\), item\.text\)\}>撤回<\/Button>/)
})

test('Pi Live Escape 和中断本轮仅在执行中可用，且不受发送请求锁影响', () => {
  assert.match(page, /window\.addEventListener\('keydown', onKeyDown\)/)
  assert.match(page, /event\.key !== 'Escape'/)
  assert.match(page, /\{optimisticStreaming && <Button[\s\S]*?className="pi-live-stop"[\s\S]*?disabled=\{abortPending \|\| queueMutationPending\}/)
  assert.match(page, /正在中断…' : '中断本轮/)
  assert.match(page, /onEscape=\{optimisticStreaming \? \(\) => void stop\(\) : undefined\}/)
})

test('medium desktop viewports reclaim space instead of forcing connection text into another row', () => {
  assert.match(css, /@media \(max-width: 1199\.98px\) \{[\s\S]*?\.pi-live-compose-runtime \{ display: none; \}/)
})
