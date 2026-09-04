import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const railCss = readFileSync(new URL('./task-turn-rail.css', import.meta.url), 'utf8')

test('轮次导轨选中态只改变颜色，不改变刻度长度', () => {
  const activeRule = railCss.match(/\.task-turn-rail \.turn-tick\.active i\s*\{([^}]*)\}/)?.[1] ?? ''

  assert.match(activeRule, /background:\s*var\(--al-ink\)/)
  assert.doesNotMatch(activeRule, /\b(?:width|height)\s*:/)
})
