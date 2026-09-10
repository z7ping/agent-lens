import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const railCss = readFileSync(new URL('./task-turn-rail.css', import.meta.url), 'utf8')

function rule(pattern: RegExp): string {
  return railCss.match(pattern)?.[1] ?? ''
}

test('轮次导轨选中态只改变颜色，不改变刻度几何', () => {
  const activeRule = rule(/\.task-turn-rail \.turn-tick\.active i\s*\{([^}]*)\}/)

  assert.match(activeRule, /background:\s*var\(--al-ink\)/)
  assert.doesNotMatch(activeRule, /\b(?:width|height)\s*:/)
})

test('轮次导轨 hover 只横向展开，running 只用颜色和光晕强调', () => {
  const hoverRule = rule(/\.task-turn-rail \.turn-tick:hover i\s*\{([^}]*)\}/)
  const runningRule = rule(/\.task-turn-rail \.turn-tick\.running i\s*\{([^}]*)\}/)

  assert.match(hoverRule, /width:\s*24px/)
  assert.doesNotMatch(hoverRule, /\bheight\s*:/)
  assert.match(runningRule, /background:\s*var\(--al-accent\)/)
  assert.match(runningRule, /box-shadow:/)
  assert.doesNotMatch(runningRule, /\b(?:width|height)\s*:/)
})
