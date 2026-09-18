import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const taskDetailCss = readFileSync(new URL('../task-detail.css', import.meta.url), 'utf8')
const taskMessageSource = readFileSync(new URL('./TaskMessage.tsx', import.meta.url), 'utf8')

test('Assistant 隐藏操作在 hover 与 keyboard focus 下都可见且保持 overlay', () => {
  assert.match(taskDetailCss, /\.task-message-assistant \.markdown-message-actions \{[\s\S]*?position: absolute;[\s\S]*?opacity: 0;/)
  assert.match(taskDetailCss, /\.task-message-assistant:hover \.markdown-message-actions,[\s\S]*?\.task-message-assistant:focus-within \.markdown-message-actions,[\s\S]*?data-view='source'[\s\S]*?opacity: \.82;/)
})

test('TaskMessage 通过统一附件字段渲染历史图片而不识别具体 Agent', () => {
  assert.match(taskMessageSource, /attachments\?: readonly TaskMessageAttachment\[\]/)
  assert.match(taskMessageSource, /attachment\.previewUrl \|\| attachment\.dataUrl/)
  assert.doesNotMatch(taskMessageSource, /sourceId\s*===\s*['"]pi['"]/)
  assert.match(taskDetailCss, /\.task-message-attachment-image \{[\s\S]*?object-fit: contain;/)
})
