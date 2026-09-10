import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('./PiLivePage.tsx', import.meta.url), 'utf8')
const taskRound = readFileSync(new URL('./PiLiveTaskRound.tsx', import.meta.url), 'utf8')
const taskMessage = readFileSync(new URL('./TaskMessage.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../pi-live.css', import.meta.url), 'utf8')
const sessionCss = readFileSync(new URL('../task-session-view.css', import.meta.url), 'utf8')
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
  assert.match(sessionCss, /\.task-session-view \.task-session-reader \{[\s\S]*?scrollbar-gutter:\s*stable;/)
  assert.match(sessionCss, /\.task-session-view \.task-session-reader \{[\s\S]*?overflow-anchor:\s*none;/)
  assert.doesNotMatch(css, /\.pi-live-reader\s*\{/)
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
