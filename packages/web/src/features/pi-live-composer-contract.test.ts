import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('./PiLivePage.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../pi-live.css', import.meta.url), 'utf8')
const pill = readFileSync(new URL('../components/ComposerPillSelect.tsx', import.meta.url), 'utf8')
const pillCss = readFileSync(new URL('../components/composer-pill-select.css', import.meta.url), 'utf8')
const markdownCss = readFileSync(new URL('../components/markdown-content.css', import.meta.url), 'utf8')

test('Pi Live model and thinking controls use custom pill menus instead of native selects', () => {
  assert.match(page, /<ComposerPillSelect[\s\S]*?ariaLabel="Pi 模型"/)
  assert.match(page, /<ComposerPillSelect[\s\S]*?ariaLabel="Pi 推理强度"/)
  assert.match(page, /title=\{state\?\.model \? `Pi 模型 · \$\{modelLabel\(state\)\}` : 'Pi 模型'\}/)
  assert.match(page, /title=\{`Pi 推理强度 · \$\{state\?\.thinkingLevel \|\| '未设置'\}`\}/)
  assert.match(pill, /createPortal\(/)
  assert.match(pillCss, /\.composer-pill-menu\s*\{[\s\S]*?position:\s*fixed;/)
})

test('Pi Live composer accepts Markdown source directly without exposing a preview toggle', () => {
  assert.match(page, /aria-label="Pi Markdown 输入"/)
  assert.match(page, /title="Enter 发送 · Alt\+Enter 完成后继续 · Shift\+Enter 换行 · 生成中 Esc 中断"/)
  assert.match(markdownCss, /button\[aria-label='预览 Markdown'\],[\s\S]*?display:\s*none;/)
})

test('Pi Live 初始化期间仍允许输入并可暂存首条任务', () => {
  assert.match(page, /state\?\.status === 'initializing'/)
  assert.match(page, /取消启动/)
  assert.match(page, /state\?\.status === 'failed'/)
  assert.match(page, /piLiveApi\.retry\(runtimeId\)/)
  assert.match(page, /const canStageStartup = runtimeInitializing && !startupQueued/)
  assert.match(page, /disabled=\{runtimeTerminating\}/)
})

test('medium desktop viewports reclaim space instead of forcing connection text into another row', () => {
  assert.match(css, /@media \(max-width: 1199\.98px\) \{[\s\S]*?\.pi-live-compose-runtime \{ display: none; \}/)
})
