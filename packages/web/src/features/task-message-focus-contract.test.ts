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
  assert.doesNotMatch(taskMessageSource, /CopyableCodeBlock/)
})

test('TaskMessage 通过统一附件字段渲染历史图片而不识别具体 Agent', () => {
  assert.match(taskMessageSource, /attachments\?: readonly TaskMessageAttachment\[\]/)
  assert.match(taskMessageSource, /attachment\.previewUrl \|\| attachment\.dataUrl/)
  assert.doesNotMatch(taskMessageSource, /sourceId\s*===\s*['"]pi['"]/)
  assert.match(taskDetailCss, /\.task-message-attachment-image \{[\s\S]*?object-fit: contain;/)
})
