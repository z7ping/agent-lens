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

test('轮次导轨恢复成熟版本的 hover 与 running 强调粗细', () => {
  const hoverRule = rule(/\.task-turn-rail \.turn-tick:hover i\s*\{([^}]*)\}/)
  const runningRule = rule(/\.task-turn-rail \.turn-tick\.running i\s*\{([^}]*)\}/)

  assert.match(hoverRule, /width:\s*24px/)
  assert.match(hoverRule, /height:\s*2px/)
  assert.match(runningRule, /width:\s*18px/)
  assert.match(runningRule, /height:\s*2px/)
})
