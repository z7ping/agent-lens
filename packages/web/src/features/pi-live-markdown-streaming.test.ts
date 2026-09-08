import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { splitStreamingMarkdown } from '../components/MarkdownContent'

const composer = readFileSync(new URL('../components/PiMarkdownComposer.tsx', import.meta.url), 'utf8')
const taskMessage = readFileSync(new URL('./TaskMessage.tsx', import.meta.url), 'utf8')
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
  assert.match(taskRound, /streaming=\{item\.state === 'running'\}/)
})

test('发送清空 value 时 Lexical 根节点被重建为普通段落', () => {
  assert.match(composer, /function replaceMarkdownDocument\(editor: LexicalEditor, value: string\)/)
  assert.match(composer, /root\.clear\(\)/)
  assert.match(composer, /const paragraph = \$createParagraphNode\(\)/)
  assert.match(composer, /root\.append\(paragraph\)/)
  assert.match(composer, /paragraph\.selectStart\(\)/)
  assert.match(composer, /replaceMarkdownDocument\(editor, value\)/)
})

test('Pi Live 边界导航使用整数描边，避免 1.75px 小尺寸抗锯齿发虚', () => {
  assert.match(taskSurface, /<UiIcon name="arrow-big-up" size=\{20\} strokeWidth=\{2\}\/>/)
  assert.match(taskSurface, /<UiIcon name="arrow-big-down" size=\{20\} strokeWidth=\{2\}\/>/)
})
