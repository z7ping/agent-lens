import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const railCss = readFileSync(new URL('./task-turn-rail.css', import.meta.url), 'utf8')

function rule(pattern: RegExp): string {
  return railCss.match(pattern)?.[1] ?? ''
}

test('轮次导轨选中态以语义色和光晕区分，不改变刻度几何', () => {
  const baseRule = rule(/\.task-turn-rail \.turn-tick i\s*\{([^}]*)\}/)
  const activeRule = rule(/\.task-turn-rail \.turn-tick\.active i\s*\{([^}]*)\}/)

  assert.match(baseRule, /height:\s*2px/)
  assert.match(activeRule, /background:\s*var\(--al-accent\)/)
  assert.match(activeRule, /box-shadow:/)
  assert.doesNotMatch(activeRule, /\b(?:width|height)\s*:/)
  const errorActive = rule(/\.task-turn-rail \.turn-tick\.err\.active i\s*\{([^}]*)\}/)
  assert.match(errorActive, /background:\s*var\(--al-danger\)/)
  assert.match(errorActive, /box-shadow:/)
  assert.doesNotMatch(errorActive, /\b(?:width|height)\s*:/)
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

test('轮次导轨保留 hover 原始摘要与键盘焦点，未改变命中区', () => {
  const source = readFileSync(new URL('./features/TaskSurface.tsx', import.meta.url), 'utf8')
  const tickRule = rule(/\.task-turn-rail \.turn-tick\s*\{([^}]*)\}/)
  assert.match(tickRule, /width:\s*24px/)
  assert.match(tickRule, /height:\s*9px/)
  assert.match(railCss, /\.task-turn-rail \.turn-tick:focus-visible\s*\{[^}]*outline:/)
  assert.match(railCss, /\.task-turn-rail \.turn-tick:hover::after,[\s\S]*?\.task-turn-rail \.turn-tick:focus-visible::after\s*\{ opacity: 1; \}/)
  assert.match(source, /data-tip=\{tip\}/)
  assert.match(source, /\[item\.label, item\.preview,/)
  assert.match(source, /aria-current=\{active \? 'step' : undefined\}/)
})
