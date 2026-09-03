import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('./PiLivePage.tsx', import.meta.url), 'utf8')
const taskRound = readFileSync(new URL('./PiLiveTaskRound.tsx', import.meta.url), 'utf8')
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

test('Pi Live streaming tail keeps layout stable while tokens arrive', () => {
  assert.match(taskRound, /<div className="pi-live-stream-text">\{waiting \? '等待 Pi 响应…' : streamText\}<\/div>/)
  assert.doesNotMatch(taskRound, /<MarkdownContent text=\{streamText\}\s*\/>/)
  assert.match(css, /\.pi-live-reader \{[\s\S]*?scrollbar-gutter:\s*stable;/)
  assert.match(css, /\.pi-live-reader \{[\s\S]*?overflow-anchor:\s*none;/)
  assert.match(css, /\.pi-live-stream-text \{[^}]*white-space:\s*pre-wrap;[^}]*overflow-wrap:\s*anywhere;/)
})

test('Pi Live sends optimistically into one stable current round before the first token', () => {
  assert.match(page, /const \[optimisticPrompt, setOptimisticPrompt\] = useState\(''\)/)
  assert.match(page, /const activePromptRef = useRef\(''\)/)
  assert.match(page, /const beginOptimisticPrompt = useCallback\(\(text: string\) => \{[\s\S]*?setSettledCurrentOrdinal\(null\)[\s\S]*?activePromptRef\.current = text[\s\S]*?setOptimisticPrompt\(text\)[\s\S]*?isStreaming: true/)
  assert.match(page, /startupSendingRef\.current = true[\s\S]*?setStartupQueued\([\s\S]*?beginOptimisticPrompt\(text\)[\s\S]*?piLiveApi\.prompt\(runtimeId, text\)/)
  assert.match(page, /setInput\(''\)[\s\S]*?if \(!wasStreaming\) beginOptimisticPrompt\(text\)/)
  assert.match(page, /if \(!optimisticPrompt && !state\?\.isStreaming && !thinkingText && tools\.length === 0 && !streamText\) return undefined/)
  assert.match(page, /\.\.\.\(optimisticPrompt \? \{ promptText: optimisticPrompt \} : \{\}\)/)
  assert.match(taskRound, /promptText && <TaskMessage role="user"/)
  assert.match(taskRound, /\(waiting \|\| streamText\) && <div className=\{`pi-live-stream-response\$\{waiting \? ' is-waiting' : ''\}`\} role=\{waiting \? 'status' : undefined\}>/)
  assert.match(taskRound, /waiting \? '等待 Pi 响应…' : streamText/)
})

test('Pi Live auto-follow is coalesced to one animation frame', () => {
  assert.match(page, /const followFrameRef = useRef<number \| null>\(null\)/)
  assert.match(page, /if \(!followingRef\.current \|\| followFrameRef\.current !== null\) return/)
  assert.match(page, /followFrameRef\.current = requestAnimationFrame\(\(\) => \{[\s\S]*?followFrameRef\.current = null[\s\S]*?reader\.scrollTop = target/)
  assert.doesNotMatch(page, /return \(\) => cancelAnimationFrame\(frame\)/)
  assert.match(page, /\[visibleHistoryRounds, streamText, thinkingText, tools,[\s\S]*?restored, extension\?\.id\]/)
})

test('Pi Live settle reconciles snapshot facts into the same current round shell', () => {
  assert.match(page, /const \[settledCurrentOrdinal, setSettledCurrentOrdinal\] = useState<number \| null>\(null\)/)
  assert.match(page, /const \[settledCurrentItems, setSettledCurrentItems\] = useState<PiLiveHistoryItem\[]>\(\[\]\)/)
  assert.match(page, /const freshHistory = mergePiLiveObservedThinking\(projectPiLiveHistory\(value\), observedThinkingRef\.current\)[\s\S]*?const freshRounds = projectPiLiveTaskRounds\(freshHistory\)/)
  assert.match(page, /setSettledCurrentOrdinal\(ordinal\)[\s\S]*?setSettledCurrentItems\(settledItems\)[\s\S]*?setOptimisticPrompt\(prompt\)/)
  assert.match(page, /historyRounds\.filter\(round => round\.model\.ordinal !== settledCurrentOrdinal\)/)
  assert.match(page, /return \{ \.\.\.settledProjection\.model, id: 'pi-live-current-round' \}/)
  assert.match(page, /\.\.\.\(settledCurrentItems\.length \? \{ settledItems: settledCurrentItems \} : \{\}\)/)
  assert.match(taskRound, /hasSettledItems[\s\S]*?\? <HistoryEntries items=\{omitPiLivePromptMessages\(settledItems \?\? \[\], promptText\)\} showAllEvents=\{showAllEvents\}\/>/)
  assert.match(taskRound, /model=\{model\}[\s\S]*?className="pi-live-current-round"/)
})

test('Pi Live 生成中使用专用介入和继续通道并即时展示队列', () => {
  assert.match(page, /if \(selectedMode === 'steer'\) await piLiveApi\.steer\(runtimeId, text\)/)
  assert.match(page, /else await piLiveApi\.followUp\(runtimeId, text\)/)
  assert.match(page, /setPendingQueue\(current => \[\.\.\.current, pending\]\)/)
  assert.match(page, /正在加入 Pi 队列/)
  assert.match(page, /pendingMessageCount=\{visiblePendingCount\}/)
})

test('Pi Live Escape 和停止操作不受发送请求锁影响', () => {
  assert.match(page, /window\.addEventListener\('keydown', onKeyDown\)/)
  assert.match(page, /event\.key !== 'Escape'/)
  assert.match(page, /disabled=\{!optimisticStreaming \|\| abortPending\}/)
  assert.match(page, /onEscape=\{optimisticStreaming \? \(\) => void stop\(\) : undefined\}/)
})

test('Pi Live 完成后保留流式观察到的思考', () => {
  assert.match(page, /thinkingTextRef\.current \+= delta/)
  assert.match(page, /type === 'message_end'/)
  assert.match(page, /setObservedThinking\(current =>/)
  assert.match(page, /mergePiLiveObservedThinking\(projectPiLiveHistory\(snapshot\), observedThinking\)/)
})

test('medium desktop viewports reclaim space instead of forcing connection text into another row', () => {
  assert.match(css, /@media \(max-width: 1199\.98px\) \{[\s\S]*?\.pi-live-compose-runtime \{ display: none; \}/)
})
