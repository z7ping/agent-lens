import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('./PiLivePage.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../pi-live.css', import.meta.url), 'utf8')

test('Pi Live model and thinking controls expose their complete current values', () => {
  assert.match(page, /title=\{state\?\.model \? `Pi 模型 · \$\{modelLabel\(state\)\}` : 'Pi 模型'\}/)
  assert.match(page, /title=\{`Pi Thinking Level · \$\{state\?\.thinkingLevel \|\| '未设置'\}`\}/)
  assert.match(css, /select:first-child \{ width: clamp\(240px, 25vw, 320px\); max-width: 320px; \}/)
  assert.match(css, /select:last-child \{ width: clamp\(155px, 16vw, 200px\); max-width: 200px; \}/)
})

test('Pi Live shortcut hint stays compact and advertises Escape abort semantics while streaming', () => {
  assert.match(page, /Esc 中断并恢复排队/)
  assert.match(css, /\.pi-live-compose-hint,[\s\S]*?font-size: 12px;/)
  assert.match(css, /\.pi-live-compose-hint,[\s\S]*?position: absolute;/)
})

test('medium desktop viewports reclaim space instead of forcing connection text into another row', () => {
  assert.match(css, /@media \(max-width: 1199\.98px\) \{[\s\S]*?\.pi-live-compose-runtime \{ display: none; \}/)
})
