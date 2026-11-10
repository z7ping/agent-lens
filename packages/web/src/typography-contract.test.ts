import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const typography = readFileSync(new URL('./typography.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('字体响应式只跟随共享 lg 边界，不保留 900px 私有断点', () => {
  assert.doesNotMatch(typography, /@media\s*\(max-width:\s*900px\)/)
  assert.match(typography, /@media\s*\(max-width:\s*991\.98px\)/)
})


const taskDetail = readFileSync(new URL('./task-detail.css', import.meta.url), 'utf8')
const taskSessionView = readFileSync(new URL('./task-session-view.css', import.meta.url), 'utf8')
const taskComposer = readFileSync(new URL('./task-session-composer.css', import.meta.url), 'utf8')
const liveComposer = readFileSync(new URL('./components/live-markdown-composer.css', import.meta.url), 'utf8')
const taskCenter = readFileSync(new URL('./task-center.css', import.meta.url), 'utf8')

test('Live/Review 桌面和移动端正文 14px、过程/代码 13px、辅助不低于 12px', () => {
  const taskTypography = typography.split('/*\n * Compact Task reading')[1]?.split('\nhtml body')[0] ?? ''
  assert.match(taskTypography, /--text-task-body:var\(--font-size-md\);/)
  assert.doesNotMatch(taskTypography, /--text-task-body:var\(--font-size-sm\);/)
  for (const role of ['process', 'thinking-markdown', 'tool', 'tool-code', 'code']) {
    assert.ok(taskTypography.includes('--text-task-' + role + ':var(--font-size-sm);'), role)
  }
  assert.match(typography, /--text-task-meta:var\(--text-caption\)/)
})

test('Task Surface 紧凑密度由现有 Owner 管理，不缩共享命中区', () => {
  assert.match(taskDetail, /\.task-surface \.task-message-assistant \.markdown \{ line-height: 1\.72; \}/)
  assert.match(taskDetail, /\.task-surface \.task-message-assistant \.markdown > :is\(h1, h2, h3, h4, h5, h6\) \{[\s\S]*?font-size: var\(--text-task-heading\);/)
  assert.match(taskDetail, /\.task-surface \.markdown :not\(pre\) > code \{[^}]*font-size: var\(--text-task-code\);/)
  assert.match(taskDetail, /\.task-tool-call > summary\.task-tool-row \{[\s\S]*?min-height: 26px;/)
  assert.match(taskSessionView, /\.task-session-composer \{ padding-inline: 36px; \}/)
  assert.match(taskCenter, /padding: 11px 8px 11px 10px;/)
  assert.match(taskComposer, /font-size: var\(--text-control\);\s*line-height: 1\.5;/)
  assert.match(taskComposer, /:not\(pre\) > code \{[^}]*font-size: var\(--text-caption\);/)
  assert.match(liveComposer, /\.live-markdown-placeholder \{[\s\S]*?font-size: var\(--text-control\);/)
  assert.match(liveComposer, /\.live-md-inline-code \{[\s\S]*?font-size: var\(--text-caption\);/)
})
