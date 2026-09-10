import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const tokens = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')
const typography = readFileSync(new URL('./typography.css', import.meta.url), 'utf8')
const taskSession = readFileSync(new URL('./task-session-view.css', import.meta.url), 'utf8')
const mainEntry = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')

test('P1-04 / P1-05：Review 与 Pi Live 共用 1120px Task Surface 几何语义', () => {
  assert.match(tokens, /--al-content-task-reading:1120px;/)
  assert.match(tokens, /--al-content-task-composer:1120px;/)
  assert.match(tokens, /--al-space-page-x:28px;/)
  assert.match(tokens, /--al-safe-composer-inline:18px;/)
  assert.match(tokens, /--al-task-turn-rail-bottom-reserve:145px;/)
  assert.match(taskSession, /max-width: var\(--al-content-task-reading\);/)
  assert.match(taskSession, /padding: 3px var\(--al-safe-composer-inline\) 10px;/)
  assert.match(taskSession, /@container task-surface \(max-width: 991\.98px\)/)
  assert.match(taskSession, /task-session-document,[\s\S]*?task-session-composer \{ padding-inline: 96px; \}/)
})

test('P1-07：关键前景/背景和来源色同时覆盖 Light / Dark', () => {
  assert.match(tokens, /--al-on-accent:#FFFFFF;/)
  assert.match(tokens, /--al-user-bubble-link:#C8C7FF;/)
  assert.match(tokens, /--src-hermes:#8B5CF6;/)
  assert.match(tokens, /--src-opencode:#0E7490;/)
  assert.match(tokens, /--src-dsh:#B66E1A;/)
  assert.match(tokens, /:root\[data-theme='dark'\][\s\S]*?--src-hermes:#B69CFF;/)
  assert.match(tokens, /:root\[data-theme='dark'\][\s\S]*?--src-opencode:#67D4E8;/)
  assert.match(tokens, /:root\[data-theme='dark'\][\s\S]*?--src-dsh:#F0B66C;/)
})

test('正式字体真值由 typography.css 在 tokens.css 之后收口为系统字体', () => {
  assert.match(typography, /--font-ui:system-ui,-apple-system,BlinkMacSystemFont/)
  assert.ok(mainEntry.indexOf("import './tokens.css'") < mainEntry.indexOf("import './typography.css'"))
})
