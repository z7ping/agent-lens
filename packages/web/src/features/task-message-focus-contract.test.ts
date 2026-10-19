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
  assert.match(taskDetailCss, /\.task-message-actions \{ display: inline-flex;/)
  assert.doesNotMatch(taskDetailCss, /\.task-message-actions \{ display: none;/)
  assert.match(taskMessageSource, /\{actions && <span className="task-message-actions">\{actions\}<\/span>\}/)
  assert.match(taskMessageSource, /actions && \(!text \|\| awaitingFirstContent\) && <div className="task-message-actions"/)
})

test('核心视图保留未识别事件可达性，不用无依据的全量计数', () => {
  const review = [
    readFileSync(new URL('./ReviewPage.tsx', import.meta.url), 'utf8'),
    readFileSync(new URL('./ReviewRoundPresentation.tsx', import.meta.url), 'utf8'),
  ].join('\n')
  assert.match(review, /const unknownCount = groups\.reduce/)
  assert.match(review, /!showAllEvents && unknownCount > 0/)
  assert.match(review, /onShowAllEvents=\{toggleEventVisibility\}/)
  assert.match(review, /onClick=\{onShowAllEvents\}/)
  assert.match(review, /entry\.type === 'raw-event-group'/)
})

test('Review / Live 用户气泡保持原有右对齐与断点宽度，不约束消息行', () => {
  assert.match(taskDetailCss, /\.task-surface \.task-message-user \{ justify-content: flex-end; \}/)
  assert.match(taskDetailCss, /\.task-surface \.task-message-bubble-user \{[^}]*max-width: min\(64%, 760px\);/)
  assert.doesNotMatch(taskDetailCss, /\.task-surface \.task-message-user \{[^}]*max-width:/)
  assert.match(taskDetailCss, /@media \(max-width: 991\.98px\) \{[\s\S]*?\.task-surface \.task-message-bubble-user \{ max-width: 88%; \}/)
  assert.match(taskMessageSource, /const roleClass = user \? 'task-message-user' : 'task-message-assistant'/)
})

test('过程文本不重复出现复制/源码，正式答案仍可操作', () => {
  assert.match(taskMessageSource, /showContentActions\?: boolean/)
  assert.match(taskMessageSource, /showContentActions = true/)
  assert.match(taskMessageSource, /!user && showContentActions && <IconButton/)
  assert.match(taskMessageSource, /!user && showContentActions && <button type="button" className="task-message-source-action"/)
  const review = readFileSync(new URL('./ReviewRoundPresentation.tsx', import.meta.url), 'utf8')
  assert.match(review, /showContentActions=\{entry\.node\.id === lastAssistantId\}/)
  assert.match(review, /function MarkdownSurface\(\{ text \}/)
  assert.doesNotMatch(review, /function MarkdownSurface\([\s\S]*?markdown-message-actions/)
})
