import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('./PiLivePage.tsx', import.meta.url), 'utf8')
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
})

test('medium desktop viewports reclaim space instead of forcing connection text into another row', () => {
  assert.match(css, /@media \(max-width: 1199\.98px\) \{[\s\S]*?\.pi-live-compose-runtime \{ display: none; \}/)
})
