import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const taskDetailCss = readFileSync(new URL('../task-detail.css', import.meta.url), 'utf8')
const taskMessageSource = readFileSync(new URL('./TaskMessage.tsx', import.meta.url), 'utf8')

test('Assistant 模型输出操作栏固定在正文底部并支持复制', () => {
  assert.match(taskDetailCss, /\.task-message-assistant \.markdown-message-actions \{[\s\S]*?position: static;[\s\S]*?opacity: \.72;/)
  assert.match(taskMessageSource, /className="task-message-copy-action"/)
  assert.match(taskMessageSource, /await copyText\(text\)/)
  assert.match(taskMessageSource, /name=\{copyState === 'copied' \? 'check' : 'copy'\}/)
  assert.match(taskMessageSource, /className="task-message-source-action"/)
  assert.match(taskMessageSource, /view === 'rendered' \? <MarkdownContent[\s\S]*: <CopyableCodeBlock/)
})

test('TaskMessage 通过统一附件字段渲染历史图片而不识别具体 Agent', () => {
  assert.match(taskMessageSource, /attachments\?: readonly TaskMessageAttachment\[\]/)
  assert.match(taskMessageSource, /attachment\.previewUrl \|\| attachment\.dataUrl/)
  assert.doesNotMatch(taskMessageSource, /sourceId\s*===\s*['"]pi['"]/)
  assert.match(taskDetailCss, /\.task-message-attachment-image \{[\s\S]*?object-fit: contain;/)
})

test('Native 消息操作不能因样式隐藏，扩展动作保留可见入口', () => {
  assert.match(taskDetailCss, /\.task-message-actions \{ display: flex;/)
  assert.doesNotMatch(taskDetailCss, /\.task-message-actions \{ display: none;/)
  assert.match(taskMessageSource, /\{actions && <div className="task-message-actions">\{actions\}<\/div>\}/)
})

test('核心视图保留未识别事件可达性，不用无依据的全量计数', () => {
  const review = readFileSync(new URL('./ReviewPage.tsx', import.meta.url), 'utf8')
  assert.match(review, /const unknownCount = groups\.reduce/)
  assert.match(review, /!showAllEvents && unknownCount > 0/)
  assert.match(review, /onShowAllEvents=\{toggleEventVisibility\}/)
  assert.match(review, /onClick=\{onShowAllEvents\}/)
  assert.match(review, /entry\.type === 'raw-event-group'/)
})
