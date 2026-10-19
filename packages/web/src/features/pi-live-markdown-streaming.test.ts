import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { splitStreamingMarkdown } from '../components/MarkdownContent'

const composer = readFileSync(new URL('../components/LiveMarkdownComposer.tsx', import.meta.url), 'utf8')
const taskMessage = readFileSync(new URL('./TaskMessage.tsx', import.meta.url), 'utf8')
const genericLive = readFileSync(new URL('./LiveTaskPage.tsx', import.meta.url), 'utf8')
const liveTaskTimeline = readFileSync(new URL('./LiveTaskTimeline.tsx', import.meta.url), 'utf8')
const taskDetailCss = readFileSync(new URL('../task-detail.css', import.meta.url), 'utf8')
const taskRound = readFileSync(new URL('./PiLiveTaskRound.tsx', import.meta.url), 'utf8')
const taskSurface = readFileSync(new URL('./TaskSurface.tsx', import.meta.url), 'utf8')

test('流式 Markdown 只提交已闭合块，当前块保持实时正文', () => {
  assert.deepEqual(splitStreamingMarkdown('## 标题\n\n当前 **尚未闭合'), {
    settled: '## 标题\n\n',
    tail: '当前 **尚未闭合',
  })
})

test('流式 Markdown 不会在未闭合 fenced code 中间切块', () => {
  assert.deepEqual(splitStreamingMarkdown('```ts\nconst a = 1\n\nconst b = 2\n'), {
    settled: '',
    tail: '```ts\nconst a = 1\n\nconst b = 2\n',
  })
  assert.deepEqual(splitStreamingMarkdown('```ts\nconst a = 1\n```\n\n后续'), {
    settled: '```ts\nconst a = 1\n```\n\n',
    tail: '后续',
  })
})

test('Pi Live assistant 与 thinking 都把 running 状态交给统一 MarkdownContent', () => {
  assert.match(taskMessage, /<MarkdownContent text=\{text\} streaming=\{streaming\}\/>/)
  assert.match(taskRound, /<MarkdownContent text=\{text\} streaming=\{streaming\}\/>/)
  assert.match(taskRound, /streaming=\{state === 'running' && item\.state === 'running'\}/)
})

test('显式草稿 revision 才重建 Lexical 文档，本地编辑不会形成受控值回声', () => {
  assert.match(composer, /interface LiveMarkdownComposerDraft[\s\S]*?revision: number[\s\S]*?value: string/)
  assert.match(composer, /function ExternalDraftPlugin\(\{ draft \}/)
  assert.match(composer, /\[draft\.revision, draft\.value, editor\]/)
  assert.match(composer, /editor\.isComposing\(\)/)
  assert.match(composer, /function replaceMarkdownDocument\(editor: LexicalEditor, value: string\)/)
  assert.match(composer, /root\.clear\(\)/)
  assert.match(composer, /const paragraph = \$createParagraphNode\(\)/)
  assert.match(composer, /root\.append\(paragraph\)/)
  assert.match(composer, /paragraph\.selectStart\(\)/)
  assert.doesNotMatch(composer, /function ExternalValuePlugin/)
})

test('Pi Live 边界导航使用整数描边，避免 1.75px 小尺寸抗锯齿发虚', () => {
  assert.match(taskSurface, /<UiIcon name="arrow-big-up" size=\{20\} strokeWidth=\{2\}\/>/)
  assert.match(taskSurface, /<UiIcon name="arrow-big-down" size=\{20\} strokeWidth=\{2\}\/>/)
})

test('Pi 与通用 Live 共享等待首响应占位，动画只作用于状态标记', () => {
  assert.match(taskMessage, /awaitingFirstContent = !user && \(pending \|\| \(streaming && !text && attachments\.length === 0\)\)/)
  assert.match(taskMessage, /task-message-response-activity/)
  assert.match(genericLive, /showResponsePending=\{Boolean\(state\?\.isStreaming\)/)
  assert.match(liveTaskTimeline, /model=\{awaitingResponse \? \{ \.\.\.projection\.model, state: 'running' \} : projection\.model\}/)
  assert.match(liveTaskTimeline, /<TaskSessionMessage role="assistant" text="" presentation=\{\{ author: agentLabel \}\} pending/)
  assert.match(taskDetailCss, /\.task-surface \.task-message-response-pending\s*\{[\s\S]*?min-height:\s*28px/)
  assert.match(taskDetailCss, /prefers-reduced-motion:\s*reduce/)
})

test('工具/思考正在执行时固定布局与图标，Token 速度不用字符数估算', () => {
  assert.match(taskDetailCss, /grid-template-columns:\s*14px auto minmax\(0, 1fr\) auto 14px/)
  assert.match(taskDetailCss, /\.task-tool-status-mark/)
  assert.match(taskDetailCss, /\.task-thinking-running-mark/)
  assert.match(genericLive, /runtimeDisclosures/)
  assert.match(liveTaskTimeline, /<TaskSessionThinking/)
  assert.doesNotMatch(genericLive, /observedOutputTokenSpeed|charsPerSecond/)
})
